/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - Decoder probes
 *
 * Reads the block loop takes off the decoder (and this node's own blocks table)
 * outside block processing: the REORG_HALT marker, this chain's BTC block-1
 * identity and the hub price-mirror horizon. None of them throws into the loop.
 * Installed onto XChainIndexer.prototype by ../XChainIndexer.js.
 *
 ********************************************************************/

const { getLogger } = require('../observability/index.js');

module.exports = {

    // Probe the decoder for a durable REORG_HALT marker and keep this.decoderReorgHalted
    // in sync. A halted decoder cannot advance, so the indexer would otherwise just look idle or
    // lagging. Log LOUD on the transition into halted (naming the required operator action, a full
    // decoder resync), then only periodically while it stays halted so a tight poll does not spam
    // the log. Returns the current halted boolean. Never throws to the caller: a decoderDb read
    // fault is logged and leaves the last known state unchanged (the reorg poll's own strict reads
    // still fail loud on a real fault).
    async checkDecoderReorgHalt(){
        if(!this.decoderDb) return this.decoderReorgHalted;
        let halted;
        try {
            let probe = await this.decoderDb.isReorgHalted();
            halted = !!(probe && probe.halted);
            var payload = probe ? probe.payload : null;
        } catch(e){
            getLogger().warn('XChainIndexer: REORG_HALT probe failed (non-fatal), keeping last known state (' +
                this.decoderReorgHalted + '): ' + (e && e.message));
            return this.decoderReorgHalted;
        }
        if(halted && !this.decoderReorgHalted){
            getLogger().error('XChainIndexer: DECODER REORG HALT detected - the decoder wrote a durable ' +
                'REORG_HALT marker (a reorg it could not safely rewind) and will not advance. The ' +
                'indexer is now blocked behind it and will present as idle/lagging until resolved. ' +
                'OPERATOR ACTION: a full decoder resync (clean reindex of decoder+indexer) always ' +
                'resolves it; where the halt has been reviewed and a resync is not required, ' +
                '`xchain-node clear-reorg-halt` clears it in place.' +
                (payload ? ' Marker detail: ' + payload : ''));
            this._reorgHaltLogTick = 0;
        } else if(halted){
            // Periodic reminder while it stays halted (every ~60 polls), not every tick.
            if((this._reorgHaltLogTick++ % 60) === 0)
                getLogger().error('XChainIndexer: decoder still REORG-HALTED; resync the decoder or clear ' +
                    'the reviewed halt with `xchain-node clear-reorg-halt`.');
        } else if(!halted && this.decoderReorgHalted){
            getLogger().warn('XChainIndexer: decoder halt is no longer live; a newer REORG_HALT_CLEARED ' +
                'marker supersedes it, or the halt marker is absent.');
        }
        this.decoderReorgHalted = halted;
        return halted;
    },

    // Resolve (and memoize) this chain's instance identity: the hash of BITCOIN block 1.
    //
    // Bitcoin only. The cross-chain tables are BTC-anchored, so the hub stamps its rows with
    // the id its Bitcoin indexer reports and every mirror fences on it; a DOGE or LTC indexer
    // has no such chain of its own to read and learns the id from the hub's snapshot
    // envelopes instead (HubDbSync.setExpectedBtcChainId with source 'hub').
    //
    // Returns null while block 1 is not in the decoder database yet, which is the normal
    // state of a freshly re-genesised regtest chain at startup: nothing is pushed and no
    // fence is armed until it resolves, and the caller retries once per parsed block. The
    // read is memoized because block 1's hash cannot change without a reorg that deep, which
    // is a new chain rather than an event this process survives.
    //
    // Never throws: the identity is transport (it enters no canonical and no block-hash
    // preimage), so a decoder read fault must never reach the block loop.
    async resolveBtcChainId(){
        if(this.btcChainId) return this.btcChainId;
        if(this.config['COIN'] !== 'BTC') return null;
        let hash = null;
        try {
            hash = await this.decoderDb.getDecoderBlockHash(1);
        } catch(e){
            return null;
        }
        if(typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
        this.btcChainId = hash;
        getLogger().info('Chain identity  : BTC block 1 is ' + hash + ' (stamped on this hub\'s cross-chain rows)');
        // Authoritative for this node: a hub advertising another chain never overrides it.
        if(this.hubDbSync && typeof this.hubDbSync.setExpectedBtcChainId === 'function'){
            try { await this.hubDbSync.setExpectedBtcChainId(hash, 'local'); }
            catch(e){ getLogger().warn('HubDbSync: could not set the local chain identity:', e.message); }
        }
        return this.btcChainId;
    },

    // Horizon for the hub price-mirror bound: the unix second below which no block
    // this indexer will process can read a price round. HubDbSync bootstraps price_snapshots
    // from here up, plus its own margin of pre-horizon rounds, instead of replaying the
    // oracle's entire history (411,609 rows / ~13 min on a testnet BTC reparse, growing by
    // ~5,184 rows a day forever) before the price barrier can arm.
    //
    // Derivation, and why each term is here:
    //   - the oldest block this node will process from here. Resuming, that is the tip it
    //     stopped at; with nothing indexed it is the decoder's FIRST block, which on a clean
    //     reindex sits at genesis and correctly yields a horizon so old that nothing is bound
    //     out at all. So a full replay still mirrors the full history, by construction.
    //   - two FIAT_DISPENSER_PRICE_WINDOWs, because reverseOraclePriceMatch's batched read
    //     reaches (blockTime - window) - window behind the block it settles.
    //   - one day of slop for block-time non-monotonicity (MTP, the 2h future-time allowance)
    //     and for a reorg rolling this node back below the resume point without a restart.
    // HubDbSync adds the round-count margin its own consensus reads need on top of this, and
    // polices the result: a block that turns up below the floor abandons the bound and
    // re-mirrors in full rather than settling short.
    //
    // Returns null - meaning "mirror everything", the unbounded behavior - whenever the
    // horizon cannot be established: no blocks anywhere yet, an unresolvable block time, or
    // any read fault. Never throws.
    async priceMirrorHorizon(){
        const SLOP_SECONDS = 86400;
        // Local null test rather than this.util.isNull: util is wired in start(), and a
        // horizon that silently answered "mirror everything" because a helper was missing
        // would be indistinguishable from a horizon that could not be established.
        const absent = (v) => (v === null || v === undefined);
        try {
            let lastIndexed = await this.indexerDb.getBlockIndex('indexer', 'last');
            // Anchor on a block that EXISTS. Resuming, that is the last block parsed rather
            // than the next one: the next block is often not decoded yet (a caught-up node
            // restarting), and one block earlier is the conservative direction anyway. Its
            // time is read from this node's own blocks table, which is guaranteed to hold it.
            let anchorDb    = absent(lastIndexed) ? this.decoderDb : this.indexerDb;
            let anchorBlock = absent(lastIndexed)
                                 ? await this.decoderDb.getBlockIndex('decoder', 'first')
                                 : Number(lastIndexed);
            if(absent(anchorBlock)) return null;
            // Raw stamp, not protocol time: this is a retention boundary compared against
            // hub round timestamps, not a consensus gate, and getRawBlockTime is the reader
            // that does not depend on the previous-block window existing yet.
            let blockTime = await anchorDb.getRawBlockTime(anchorBlock);
            if(blockTime === false || !Number.isFinite(Number(blockTime)) || Number(blockTime) <= 0)
                return null;
            let fiatWindow = parseInt((this.config || {})['FIAT_DISPENSER_PRICE_WINDOW']) || 86400;
            return Number(blockTime) - (2 * fiatWindow) - SLOP_SECONDS;
        } catch(e){
            getLogger().warn('XChainIndexer: price mirror horizon unavailable (' + (e && e.message) +
                '); the hub price mirror will bootstrap in full');
            return null;
        }
    }
};
