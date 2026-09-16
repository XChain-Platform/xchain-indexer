/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Indexer - Genesis Ledger Bootstrap
 *
 * Injects Counterparty/Dogeparty asset-NAME ownership into the XChain ledger at
 * a configured genesis block. Each name in the bundled manifest (tick,owner CSV)
 * is issued by the GAS address and ends up owned by its real owner, so every
 * reserved name has a genuine GAS-issued chain of custody.
 *
 * XChain gates subtoken creation on owning the parent (issue.js), so GAS must own
 * a parent while its children are created. We split the manifest into ancestors
 * (names that are the parent-prefix of another name) and leaves (no descendants):
 *   - Leaf: a single ISSUE that both creates the tick and TRANSFERs it to its owner.
 *     The parent gate reads the parent's owner BEFORE the in-action transfer, so the
 *     create+transfer is accepted as long as GAS still owns the parent at that point.
 *   - Ancestor: created owned by GAS in the create pass (transfer deferred), then
 *     handed to its owner in a cleanup pass over ancestors only, in REVERSE order
 *     (child-ancestor before parent-ancestor) so a parent stays GAS-owned until its
 *     descendants are placed. GAS-owned ancestors need no transfer.
 * This collapses the historical "issue every name twice" to one action per leaf
 * (the vast majority) while still landing divergent-owner subassets correctly.
 * Name ownership only; no balances (the airdrop is separate).
 *
 * Determinism is consensus-critical: the same manifest, applied in the same order
 * with deterministic synthetic tx hashes, produces identical ledger/state hashes
 * on every node. The manifest is pinned by sha256 (GENESIS_LEDGER_HASH); a
 * mismatch halts the node.
 *
 ********************************************************************/

const fs     = require('fs');
const crypto = require('crypto');

const { getLogger } = require('../observability/index.js');
let GenesisDump = require('./genesis_dump');

// The manifest-row, airdrop, token-row and bridged-row methods live in ./genesis/ by
// concern and are installed onto Genesis.prototype at the foot of this file, so every
// call site (and every test stub on the prototype) still reads this.<method>().
const rowMethods           = require('./genesis/rows.js');
const airdropMethods       = require('./genesis/airdrops.js');
const protocolTokenMethods = require('./genesis/protocol_token.js');
const bridgedTokenMethods  = require('./genesis/bridged_token.js');

class Genesis {

    constructor(actions, indexerDb, config, util){
        this.actions   = actions;
        this.indexerDb = indexerDb;
        this.config    = config;
        this.util      = util;
    }

    // Called once per block from the indexer loop. No-op unless this is the
    // configured genesis block for this chain (GENESIS_BLOCK = 0 disables it).
    async inject(blockToParse, blockTime){
        let genesisBlock = this.config['GENESIS_BLOCK'];
        if(!genesisBlock || Number(blockToParse) !== Number(genesisBlock))
            return;

        let gas = this.config['ADDRESS']['GAS'];

        if(await this.importGenesisDumpIfPresent(blockToParse))
            return;

        let file = this.config['GENESIS_LEDGER_PATH'];
        getLogger().info('GENESIS: bootstrapping ' + this.config['COIN'] + ' name ownership at block ' + blockToParse + ' from ' + file);

        // Consensus checkpoint: verify the bundled manifest against the pinned hash.
        this.verifyManifest(file);

        // Load + pre-flight rows (dedupe, tick sanity, parent-before-child order).
        let rows = this.loadRows(file);

        // Enable the genesis-only intern cache for the duration of injection. The pipeline
        // re-resolves the same ticks and the constant GAS source many times per action; the
        // cache collapses those getTickerId/getAddressId SELECTs to one DB hit each. Safe
        // here only because genesis is one atomic block (ids assigned, never deleted), and
        // cleared in the finally so the block's later real transactions run uncached.
        this.indexerDb._internCache = { addr: new Map(), tick: new Map(), tx: new Map() };
        try {
            // Ancestor set: every strict prefix-parent that appears among the loaded ticks.
            // A tick is an ancestor if some OTHER tick has it as a "a", "a.b", ... prefix.
            // Ancestors must stay GAS-owned while their descendants are placed; leaves do not.
            let ancestors = this.ancestorSet(rows);

            // Gas token: inject XCHAIN as the first genesis action (BTC mainnet only). Unlike
            // the CP/DP name reservations, it carries real token parameters and is the
            // canonical creation of the platform gas token. ISSUE of XCHAIN is GAS-only
            // (issue.js) and BTC-only, so this is the single place it is ever created on a
            // live chain.
            if(this.config['COIN'] === 'BTC' && this.config['NETWORK'] === 'mainnet')
                await this.injectGasToken(gas, blockToParse, blockTime);

            await this.runNamePasses(gas, rows, ancestors, blockToParse, blockTime);

            // Airdrop pass: credit the XCP/XDP native-token allocation to snapshot
            // holders. Runs after the name passes so the whole genesis block stays one
            // deterministic action sequence: gas token, creates, ancestor transfers, credits.
            await this.injectAirdrops(gas, blockToParse, blockTime);
        } finally {
            this.indexerDb._internCache = null;
        }

        getLogger().info('GENESIS: complete - ' + rows.length + ' names injected');
    }

    // Fast path: if a precomputed state dump is present, bulk-import it instead of
    // re-deriving the ledger through the pipeline. The importer verifies the artifact
    // against GENESIS_DUMP_HASH and re-checks the recomputed block hashes (see
    // genesis_dump.js), so the imported state is provably the canonical genesis state.
    // Returns true when the dump path was taken (caller returns without running the
    // CSV-derived passes below), false when there is no dump to import.
    async importGenesisDumpIfPresent(blockToParse){
        let dumpFile = this.config['GENESIS_DUMP_PATH'];
        if(!dumpFile || !fs.existsSync(dumpFile))
            return false;
        getLogger().info('GENESIS: importing precomputed dump for ' + this.config['COIN'] + ' at block ' + blockToParse + ' from ' + dumpFile);
        if(this.util.isNull(this.config['GENESIS_DUMP_HASH']))
            getLogger().warn('GENESIS: GENESIS_DUMP_HASH is not pinned; importing on the dump-recorded block hashes only (no content-hash anchor).');
        let res = await (new GenesisDump(this.indexerDb, this.util, this.config)).read(dumpFile);
        getLogger().info('GENESIS: imported ' + res.rowsImported + ' rows (block hashes verified)');
        return true;
    }

    // Create pass: GAS issues every tick once, in file (parent-before-child) order so
    // GAS owns each parent when its children are created (the parent gate passes).
    // A leaf folds its TRANSFER into this single action (the gate reads the parent's
    // owner before the transfer is applied, and transferring a leaf never disturbs a
    // parent). An ancestor is created owned by GAS and its transfer is deferred below.
    //
    // Cleanup pass: GAS transfers each ANCESTOR to its real owner, in REVERSE file
    // order (child-ancestor before parent-ancestor). A subtoken transfer is gated on
    // the SOURCE still owning the parent (issue.js parent gate); transferring a parent
    // to its owner first would strand a descendant ancestor whose transfer still needs
    // GAS to own that parent. Reverse order keeps each ancestor's parent GAS-owned
    // until after it has been transferred, because a parent always precedes its
    // descendants in the sorted manifest. GAS-owned ancestors are skipped (already
    // left GAS-owned by the create pass); leaves were already transferred above.
    async runNamePasses(gas, rows, ancestors, blockToParse, blockTime){
        for(let r of rows){
            let transfer = (!ancestors.has(r.tick) && r.owner !== gas) ? r.owner : null;
            await this.issue(gas, r.tick, transfer, blockToParse, blockTime, 1);
        }

        for(let i = rows.length - 1; i >= 0; i--)
            if(ancestors.has(rows[i].tick) && rows[i].owner !== gas)
                await this.issue(gas, rows[i].tick, rows[i].owner, blockToParse, blockTime, 2);
    }

    // sha256 the manifest and compare to the pinned GENESIS_LEDGER_HASH. A null pin
    // skips the check (pre-pin dev/regtest); a mismatch halts the node, since applying
    // a different manifest would fork the ledger.
    verifyManifest(file){
        let expected = this.config['GENESIS_LEDGER_HASH'];
        if(this.util.isNull(expected))
            return;
        let actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if(actual !== String(expected).toLowerCase()){
            getLogger().error('GENESIS FATAL: ledger hash mismatch for ' + file + ' (expected ' + expected + ', got ' + actual + '). Halting.');
            throw new Error('Genesis ledger hash mismatch');
        }
    }

    // Synthesize one genesis action and run it through the normal action pipeline with the
    // genesis flag set (fee-exempt + wrong-network TRANSFER allowed; see issue.js / actions.js).
    // pass 1 = create from GAS (with TRANSFER=owner for a leaf, no TRANSFER for an ancestor);
    // pass 2 = the deferred ancestor transfer (re-issue from GAS with TRANSFER=owner). The pass
    // number feeds the tx hash, so a leaf (pass 1 only) and an ancestor (pass 1 + pass 2) never
    // collide. The tx hash is deterministic so a reindex replays to identical action indexes/hashes.
    async issue(gas, tick, transfer, blockToParse, blockTime, pass){
        // ISSUE format 0: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|...
        let fields = ['ISSUE', '0', tick];
        if(!this.util.isNull(transfer))
            fields.push('', '', '', '', '', transfer); // skip the 5 fields before TRANSFER
        // Deterministic, fixed-width synthetic tx hash. Embedding the raw tick overflowed
        // the 64-char unique prefix on index_transactions.hash, so long ticks sharing a
        // 64-char prefix collided to a NULL tx_hash_id. A sha256 digest of (coin,pass,tick)
        // keeps the hash deterministic and collision-free inside the indexed width; the
        // readable GENESIS-<coin>-P<pass>- prefix preserves explorer legibility (64 chars).
        let digest = crypto.createHash('sha256')
            .update(this.config['COIN'] + '|' + pass + '|' + tick).digest('hex').slice(0, 48);
        let tx = {
            data:          fields.join('|'),
            source:        gas,
            destination:   null,
            amount:        null,
            tx_hash:       'GENESIS-' + this.config['COIN'] + '-P' + pass + '-' + digest,
            vout:          0,
            block_index:   blockToParse,
            block_time:    blockTime,
            raw_data:      null,
            fee:           null,
            source_pubkey: null,
            tx_outputs:    []
        };
        await this.actions.processTransaction(tx, true); // isGenesis = true
    }
}

Object.assign(Genesis.prototype, rowMethods, airdropMethods, protocolTokenMethods, bridgedTokenMethods);

module.exports = Genesis;
