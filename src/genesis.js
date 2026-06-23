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
 * is created by the GAS address and then transferred to its real owner, so every
 * reserved name has a genuine ISSUE + TRANSFER chain of custody.
 *
 * Two passes are required because XChain gates subtoken creation on owning the
 * parent (issue.js): GAS transiently owns the whole tree during pass 1 (parent
 * before child, the manifest's tick-name sort order), then pass 2 hands each name
 * to its owner. This is the only way to land subassets whose owner differs from
 * the root owner. Name ownership only; no balances (the airdrop is separate).
 *
 * Determinism is consensus-critical: the same manifest, applied in the same order
 * with deterministic synthetic tx hashes, produces identical ledger/state hashes
 * on every node. The manifest is pinned by sha256 (GENESIS_LEDGER_HASH); a
 * mismatch halts the node. See claude/reports/launch/GENESIS-LEDGER-BOOTSTRAP.md.
 *
 ********************************************************************/

const fs     = require('fs');
const crypto = require('crypto');

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

        let gas  = this.config['ADDRESS']['GAS'];

        // Fast path: if a precomputed state dump is present, bulk-import it instead of
        // re-deriving the ledger through the pipeline. The importer verifies the artifact
        // against GENESIS_DUMP_HASH and re-checks the recomputed block hashes (see
        // genesisDump.js), so the imported state is provably the canonical genesis state.
        let dumpFile = this.config['GENESIS_DUMP_PATH'];
        if(dumpFile && fs.existsSync(dumpFile)){
            console.log('GENESIS: importing precomputed dump for ' + this.config['COIN'] + ' at block ' + blockToParse + ' from ' + dumpFile);
            if(this.util.isNull(this.config['GENESIS_DUMP_HASH']))
                console.warn('GENESIS: GENESIS_DUMP_HASH is not pinned; importing on the dump-recorded block hashes only (no content-hash anchor).');
            let GenesisDump = require('./genesisDump');
            let res = await (new GenesisDump(this.indexerDb, this.util, this.config)).read(dumpFile);
            console.log('GENESIS: imported ' + res.rowsImported + ' rows (block hashes verified)');
            return;
        }

        let file = this.config['GENESIS_LEDGER_PATH'];
        console.log('GENESIS: bootstrapping ' + this.config['COIN'] + ' name ownership at block ' + blockToParse + ' from ' + file);

        // Consensus checkpoint: verify the bundled manifest against the pinned hash.
        this._verifyManifest(file);

        // Load + pre-flight rows (dedupe, tick sanity, parent-before-child order).
        let rows = this._loadRows(file);

        // Enable the genesis-only intern cache for the duration of injection. The pipeline
        // re-resolves the same ticks and the constant GAS source many times per action; the
        // cache collapses those getTickerId/getAddressId SELECTs to one DB hit each. Safe
        // here only because genesis is one atomic block (ids assigned, never deleted), and
        // cleared in the finally so the block's later real transactions run uncached.
        this.indexerDb._internCache = { addr: new Map(), tick: new Map(), tx: new Map() };
        try {

        // Pass 1: GAS issues every tick (owner = GAS), in file (parent-before-child) order.
        // GAS therefore owns each parent when its children are issued, so the parent gate passes.
        for(let r of rows)
            await this._issue(gas, r.tick, null, blockToParse, blockTime, 1);

        // Pass 2: GAS transfers each tick to its real owner, in REVERSE file order
        // (children before parents). A subtoken transfer is gated on the SOURCE still
        // owning the parent (issue.js parent gate); transferring a parent to its owner
        // first would strand every child (parent no longer GAS-owned -> the child's
        // transfer is rejected and the subtoken silently stays with GAS). Reverse order
        // keeps each tick's parent GAS-owned until after the child has been transferred,
        // because a parent always precedes its descendants in the sorted manifest. Ticks
        // left to GAS (owner == GAS) are skipped: pass 1 already left them GAS-owned.
        for(let i = rows.length - 1; i >= 0; i--)
            if(rows[i].owner !== gas)
                await this._issue(gas, rows[i].tick, rows[i].owner, blockToParse, blockTime, 2);

        } finally {
            this.indexerDb._internCache = null;
        }

        console.log('GENESIS: complete - ' + rows.length + ' names injected');
    }

    // sha256 the manifest and compare to the pinned GENESIS_LEDGER_HASH. A null pin
    // skips the check (pre-pin dev/regtest); a mismatch halts the node, since applying
    // a different manifest would fork the ledger.
    _verifyManifest(file){
        let expected = this.config['GENESIS_LEDGER_HASH'];
        if(this.util.isNull(expected))
            return;
        let actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if(actual !== String(expected).toLowerCase()){
            console.error('GENESIS FATAL: ledger hash mismatch for ' + file + ' (expected ' + expected + ', got ' + actual + '). Halting.');
            throw new Error('Genesis ledger hash mismatch');
        }
    }

    // Read the manifest CSV (tick,owner_address). Owner addresses never contain a comma,
    // so the LAST comma separates tick from owner (ticks may be RFC4180-quoted and could
    // in principle contain commas). Dedupe by tick (last row wins) and skip ticks the
    // ISSUE handler would reject anyway. Finally assert parent-before-child ordering so a
    // malformed manifest fails before any DB write rather than mid-injection.
    _loadRows(file){
        let lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        let rows  = [];
        let index = new Map(); // tick -> position in rows (dedupe)
        for(let line of lines){
            if(line === '' || line === 'tick,owner_address')
                continue;
            let comma = line.lastIndexOf(',');
            if(comma < 0)
                continue;
            let tick  = line.slice(0, comma).trim();
            let owner = line.slice(comma + 1).trim();
            // Unwrap an RFC4180-quoted tick ("..."" -> ").
            if(tick.length >= 2 && tick[0] === '"' && tick[tick.length - 1] === '"')
                tick = tick.slice(1, -1).replace(/""/g, '"');
            if(tick === '' || owner === '')
                continue;
            // Protocol sanity (the handler rejects these too; skip + log rather than abort).
            if(tick.indexOf('|') !== -1 || tick.indexOf(';') !== -1){
                console.warn('GENESIS skip (separator char in tick): ' + tick);
                continue;
            }
            if(tick.length > this.config['MAX_TICK_LENGTH']){
                console.warn('GENESIS skip (tick exceeds MAX_TICK_LENGTH): ' + tick);
                continue;
            }
            if(index.has(tick))
                rows[index.get(tick)].owner = owner;  // last row wins
            else {
                index.set(tick, rows.length);
                rows.push({ tick: tick, owner: owner });
            }
        }
        // Parent-before-child invariant: a child's immediate parent must already appear.
        let present = new Set();
        for(let r of rows){
            let parts = r.tick.split('.');
            if(parts.length > 1){
                let parent = parts.slice(0, -1).join('.');
                if(!present.has(parent))
                    throw new Error('GENESIS FATAL: child "' + r.tick + '" precedes its parent "' + parent + '" in the manifest');
            }
            present.add(r.tick);
        }
        return rows;
    }

    // Synthesize one genesis action and run it through the normal action pipeline with the
    // genesis flag set (fee-exempt + wrong-network TRANSFER allowed; see issue.js / actions.js).
    // pass 1 = create owned by GAS (no TRANSFER); pass 2 = re-issue from GAS with TRANSFER=owner.
    // The tx hash is deterministic so a reindex replays to the identical action indexes/hashes.
    async _issue(gas, tick, transfer, blockToParse, blockTime, pass){
        // ISSUE format 0: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|...
        let fields = ['ISSUE', '0', tick];
        if(!this.util.isNull(transfer))
            fields.push('', '', '', '', '', transfer); // skip the 5 fields before TRANSFER
        // Deterministic, fixed-width synthetic tx hash. Embedding the raw tick overflowed
        // the 64-char unique prefix on index_transactions.hash, so long ticks sharing a
        // 64-char prefix collided to a NULL tx_hash_id. A sha256 digest of (coin,pass,tick)
        // keeps the hash deterministic and collision-free inside the indexed width; the
        // readable GENESIS-<coin>-P<pass>- prefix preserves explorer legibility (63 chars).
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

module.exports = Genesis;
