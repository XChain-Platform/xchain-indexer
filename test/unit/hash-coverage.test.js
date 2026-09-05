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
 * test/unit/hash-coverage.test.js
 *
 * Hash-coverage guard: binds the per-table `hashed` declarations in the
 * table-lifecycle registry (src/tableLifecycle.js) to the code that actually
 * computes each hash. The registry is where a new table DECLARES which
 * integrity hash would catch a divergence in it; these tests make that
 * declaration verifiable in both directions:
 *
 *   - a table declaring a class must actually be read by that hash's
 *     gathering code (a stale declaration fails), and
 *   - a table the hashing code reads must declare the class (an undeclared
 *     expansion of a hash preimage fails).
 *
 * Together with the rollback-coverage registry gates, a new consensus table
 * cannot ship with its hash story unstated.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const lifecycle = require('../../src/tableLifecycle.js');
const stateHash = require('../../src/stateHash.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

describe('Hash coverage guard @regression', function () {

    // The consensus block-hash preimage gathering lives in db.js getBlockHashes.
    // Slice its body (start of the method to the gathered-rows stash it ends on)
    // so the FROM-table assertions below cannot accidentally match unrelated SQL
    // elsewhere in db.js.
    function blockHashBody(){
        const src   = read('src/db.js');
        const start = src.indexOf('async getBlockHashes(');
        const end   = src.indexOf('this._lastGatheredBlockRows', start);
        assert.ok(start !== -1 && end > start, 'db.js getBlockHashes body not found; update this guard\'s slicing');
        return src.slice(start, end);
    }

    it('every table declaring a ledger/actions/contracts class is gathered by getBlockHashes (and the sets are pinned)', function () {
        // Value-pin the three consensus preimage table sets. Growing one is a
        // consensus change (every hash changes): it must be deliberate, and it
        // must update the registry declaration AND this pin together.
        assert.deepStrictEqual(lifecycle.hashClassTables('ledger').sort(),
            ['credits', 'debits', 'escrows'],
            'ledger-hash table set changed; this is a consensus preimage change');
        assert.deepStrictEqual(lifecycle.hashClassTables('actions').sort(),
            ['actions'],
            'actions-hash table set changed; this is a consensus preimage change');
        assert.deepStrictEqual(lifecycle.hashClassTables('contracts').sort(),
            ['contract_emissions', 'contract_executions', 'contract_state', 'contracts', 'deposits', 'withdrawals'],
            'contract-hash table set changed; this is a consensus preimage change');

        // Structural binding: each declared table is actually read inside
        // getBlockHashes (FROM <table>, allowing an alias).
        const body = blockHashBody();
        for (const cls of ['ledger', 'actions', 'contracts']) {
            for (const t of lifecycle.hashClassTables(cls)) {
                const re = new RegExp(`FROM\\s+${t}\\b`, 'i');
                assert.ok(re.test(body),
                    `${t} declares hash class '${cls}' but db.js getBlockHashes never reads it; ` +
                    `fix the registry declaration or the preimage gathering`);
            }
        }
    });

    it('state_hash class declarations exactly match the stateHash.js mutation-class tables (both directions)', function () {
        // The state_hash preimage covers in-place mutation classes plus the
        // backdated refund credits and the anchor invalid_archive stamp. Its
        // table set is derivable from the module's own exported constants, so
        // the registry declarations and the implementation are compared
        // set-for-set: a table added to either side alone fails.
        const fromCode = new Set([
            ...stateHash.DEACTIVATION_TABLES,
            ...stateHash.SLASH_SPECS.map(s => s.table),
            ...stateHash.REQUEST_STATUS_TABLES,
            ...stateHash.COOLDOWN_TABLES,
            'credits',        // backdated cooldown refund credits class
            'anchor_actions', // invalid_archive stamp class
            'polls',          // finalization-flip class (flag-day gated; structural binding below)
            'tokens',         // supply-refresh class (F-1 closure; flag-day gated; structural binding below)
            'bet_feeds',      // BET latch + terminal-flip class (flag-day gated; structural binding below)
            'bets',           // BET settlement-flip class (same flag-day; structural binding below)
        ]);
        assert.deepStrictEqual(
            lifecycle.hashClassTables('state_hash').sort(),
            [...fromCode].sort(),
            'state_hash declarations in tableLifecycle.js and the classes gathered by stateHash.js have drifted; ' +
            'a new in-place mutation class must land in BOTH (and in the updated_rows forward channel + both rollbacks)'
        );
    });

    it('every db.js method that UPDATEs attests in place is named in the attests registry note', function () {
        // The registry note is the one place that states, per writer, whether an
        // in-place attests mutation is hashed, forwarded and reset. A writer that
        // lands without a sentence there is a coverage gap nobody declared, so
        // bind the note to the set of db.js methods that issue `UPDATE attests`
        // outside the action's own upsert (the create* methods key on the row's
        // own action_index and are action-derived, not in-place mutations).
        const db      = read('src/db.js');
        const methods = new Set();
        const methodRe = /^\s{4}async ([A-Za-z_]+)\(/gm;
        let m, starts = [];
        while ((m = methodRe.exec(db)) !== null) starts.push({ name: m[1], at: m.index });
        const updateRe = /UPDATE attests\b/g;
        while ((m = updateRe.exec(db)) !== null) {
            let owner = null;
            for (const s of starts) { if (s.at < m.index) owner = s.name; else break; }
            if (owner && !/^create/.test(owner)) methods.add(owner);
        }
        assert.ok(methods.has('setAttestBatchStatus') && methods.has('setAttestationResponseBatchIndex'),
            'expected the two batch-era in-place attests writers to be found in db.js; the scan is broken');
        const note = lifecycle.entry('attests').hashed.note;
        for (const name of methods) {
            assert.ok(note.includes(name),
                `db.js ${name} mutates attests in place but the attests registry note in src/tableLifecycle.js ` +
                `does not name it; state its hash / updated_rows / rollback coverage there (and copy to the sync twin)`);
        }
    });

    it('index_map class declarations match the id-map delta tables stateHash.js gathers', function () {
        assert.deepStrictEqual(lifecycle.hashClassTables('index_map').sort(),
            ['index_addresses', 'index_tickers'],
            'index_map hash class must cover exactly the two wire-^id consensus lookups');
        // Structural binding: the armed class queries both tables by block_index.
        const src = read('src/stateHash.js');
        for (const t of ['index_addresses', 'index_tickers']) {
            assert.ok(new RegExp(`FROM ${t} WHERE block_index = \\?`).test(src),
                `stateHash.js no longer gathers the ${t} id-map delta; the index_map class declaration is stale`);
        }
    });

    it('state_commitment class declarations are pinned to the SMT inputs and stores', function () {
        // balances + BTC stakes are the SMT leaf inputs (stateCommitment.js);
        // escrow_leaf_journal is the Stage B locked-leaf input folded into the same
        // balances_root; state_tree_roots/state_tree_nodes are the commitment store
        // itself. Changing this set is an SPV-spec change: update the registry, this
        // pin, and the stateCommitment twins together.
        assert.deepStrictEqual(lifecycle.hashClassTables('state_commitment').sort(),
            ['balances', 'escrow_leaf_journal', 'stakes', 'state_tree_nodes', 'state_tree_roots'],
            'state_commitment table set changed; this is an SPV/light-client spec change');
        const src = read('src/stateCommitment.js');
        for (const t of ['balances', 'state_tree_roots', 'state_tree_nodes']) {
            assert.ok(src.indexOf(t) !== -1,
                `stateCommitment.js no longer references ${t}; the state_commitment declaration is stale`);
        }
    });

    it('escrow_leaf_journal state_commitment class: the leaf builder reads it behind the arming gate', function () {
        // Structural binding for the escrow_leaf_journal declaration, mirroring the
        // gated-class bindings above (poll_finalize / token_supply / bet_status): the
        // journal is only consensus-visible because escrowLeafSubtree.js reads it into
        // balances_root, and stateCommitment.js applies that behind
        // ESCROW_LOCKED_LEAF_ACTIVATION. If either half moves, the declaration is stale.
        const leaf = read('src/escrowLeafSubtree.js');
        assert.ok(/FROM escrow_leaf_journal j/.test(leaf),
            'escrowLeafSubtree.js no longer reads escrow_leaf_journal; its state_commitment declaration is stale');
        const commit = read('src/stateCommitment.js');
        assert.ok(commit.indexOf('applyEscrowLeaves') !== -1,
            'stateCommitment.js no longer applies the escrow leaves into balances_root');
        const act = require('../../src/state_subtree_activation.js');
        assert.ok(Number.isFinite(Number(act.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'])),
            'ESCROW_LOCKED_LEAF_ACTIVATION lost its armed BTC:regtest height; re-check the declared coverage');
    });

    it('quorum class declarations are pinned to the hub-mirrored federation-signed tables', function () {
        assert.deepStrictEqual(lifecycle.hashClassTables('quorum').sort(),
            ['capability_snapshots', 'cross_chain_calls', 'cross_chain_matches', 'price_snapshots', 'state_checkpoints'],
            'quorum-covered table set changed; verify the new/removed table\'s signature-verification story before updating this pin');
    });

    it('poll_finalize class: gated selection exists, keyed by resolved_block, armed per chain', function () {
        // Structural binding for the polls state_hash declaration: the gathering
        // SQL must select by resolved_block (the same key the updated_rows
        // forward channel and the rollback re-open use) behind the activation
        // gate, with per-chain armed heights on every real chain:network pair.
        const src = read('src/stateHash.js');
        assert.ok(/FROM polls WHERE resolved_block BETWEEN \? AND \? ORDER BY action_index ASC/.test(src),
            'stateHash.js no longer gathers the poll-finalize flip by resolved_block; the polls state_hash declaration is stale');
        const map = stateHash.POLL_FINALIZE_STATE_HASH_ACTIVATION;
        for (const key of ['BTC:mainnet', 'LTC:mainnet', 'DOGE:mainnet', 'BTC:testnet', 'LTC:testnet', 'DOGE:testnet', 'regtest'])
            assert.ok(Number.isFinite(map[key]), `POLL_FINALIZE_STATE_HASH_ACTIVATION['${key}'] missing`);
        // Surrogate-id guard: the selected columns must never include the
        // lookup ids on the polls row (they diverge across nodes).
        const sel = src.match(/SELECT[\s\S]{0,400}?FROM polls WHERE resolved_block/)[0];
        for (const banned of ['tick_id', 'deposit_address_id', 'status_id'])
            assert.ok(sel.indexOf(banned) === -1, `poll_finalize preimage must not hash surrogate id column ${banned}`);
    });

    it('token_supply class: gated selection exists, keyed by ledger-touched ticks, armed per chain (F-1 closure)', function () {
        // Structural binding for the tokens state_hash declaration: the gathering
        // SQL must derive the tick set from ledger rows at the block (the same
        // selection shape the updated_rows tokens-supply forward class uses) and
        // hash resolved (tick, supply) pairs, never surrogate ids.
        const src = read('src/stateHash.js');
        assert.ok(/SELECT tk\.tick AS tick, t\.supply AS supply FROM tokens t/.test(src),
            'stateHash.js no longer gathers (tick, supply); the tokens state_hash declaration is stale');
        for (const ledger of ['credits c', 'debits d', 'escrows e'])
            assert.ok(new RegExp(`SELECT \\w+\\.tick_id FROM ${ledger} JOIN actions a ON`).test(src),
                `token_supply selection lost its ${ledger.split(' ')[0]} ledger-touch branch`);
        const map = stateHash.TOKEN_SUPPLY_STATE_HASH_ACTIVATION;
        for (const key of ['BTC:mainnet', 'LTC:mainnet', 'DOGE:mainnet', 'BTC:testnet', 'LTC:testnet', 'DOGE:testnet', 'regtest'])
            assert.ok(Number.isFinite(map[key]), `TOKEN_SUPPLY_STATE_HASH_ACTIVATION['${key}'] missing`);
    });

    it('bet_status class: gated selections exist, keyed by the three stamps, armed per chain (P4)', function () {
        // Structural binding for the bet_feeds/bets state_hash declarations: the
        // gathering SQL must select by the stamp columns (the same keys the
        // updated_rows BET forward channel and both rollback resets use) behind
        // the activation gate, resolving status strings via index_statuses
        // (never hashing the surrogate status_id), with per-chain armed heights.
        const src = read('src/stateHash.js');
        assert.ok(/FROM bet_feeds f JOIN index_statuses s ON \(s\.id = f\.feed_status_id\)[\s\S]{0,120}?WHERE f\.closed_block = \? OR f\.terminal_block = \? ORDER BY f\.action_index ASC/.test(src),
            'stateHash.js no longer gathers the bet_feeds flips by closed_block/terminal_block; the bet_feeds state_hash declaration is stale');
        assert.ok(/FROM bets b JOIN index_statuses s ON \(s\.id = b\.bet_status_id\) [\s\S]{0,80}?WHERE b\.settled_block = \? ORDER BY b\.action_index ASC/.test(src),
            'stateHash.js no longer gathers the bets settlement flip by settled_block; the bets state_hash declaration is stale');
        const map = stateHash.BET_STATUS_STATE_HASH_ACTIVATION;
        for (const key of ['BTC:mainnet', 'LTC:mainnet', 'DOGE:mainnet', 'BTC:testnet', 'LTC:testnet', 'DOGE:testnet', 'regtest'])
            assert.ok(Number.isFinite(map[key]), `BET_STATUS_STATE_HASH_ACTIVATION['${key}'] missing`);
        // Surrogate-id guard: the selected columns resolve the status string and
        // must never include the surrogate ids on the rows.
        for (const sel of [src.match(/SELECT[\s\S]{0,200}?FROM bet_feeds f JOIN index_statuses/)[0], src.match(/SELECT[\s\S]{0,200}?FROM bets b JOIN index_statuses/)[0]])
            for (const banned of ['tick_id', 'memo_id', 'feed_status_id,', 'bet_status_id,'])
                assert.ok(sel.indexOf(banned) === -1, `bet_status preimage must not hash surrogate id column ${banned}`);
    });

    // ── Advisory content-parity coverage ──────────────────────────
    //
    // The registry's CONTENT_PARITY_* block is the coverage contract for the
    // advisory TABLE_CONTENT_PARITY_CHECK that xchain-sync computes and compares.
    // The compute side lives in that repo, but the DECLARATION lives here, in the
    // byte-identical twin, so this repo carries the guards that keep the
    // declaration honest: xchain-sync's own suite cannot fail on an indexer-side
    // registry edit that never gets copied over.
    describe('content-parity coverage declaration', function () {

        it('the operator carve-outs are exactly markets (indexer) and dispensers (decoder)', function () {
            // Pinned to the 2026-08-11 ruling. Each carve-out is a replicated table
            // deliberately left with NO content commitment, so widening this set is an
            // operator decision rather than a code change.
            assert.deepStrictEqual(
                lifecycle.CONTENT_PARITY_CARVE_OUTS.map(c => c.dbType + ':' + c.table).sort(),
                ['decoder:dispensers', 'indexer:markets']);
            for (const c of lifecycle.CONTENT_PARITY_CARVE_OUTS)
                assert.ok(c.reason && c.reason.length > 20, `${c.table} carve-out must carry its reason`);
            // dbType-scoped: this repo's own action-scoped dispensers table is COVERED;
            // only the decoder table of that name is out.
            assert.strictEqual(lifecycle.contentParityCarveOut('dispensers', 'indexer'), null);
            assert.ok(lifecycle.contentParityCarveOut('dispensers', 'decoder'));
        });

        it('the mutable exclusion class is derived from the state_hash declarations, not hand-listed', function () {
            // Those tables are excluded from the window checksum because an in-place
            // edit in a later block moves content inside an already-published window,
            // AND because the enforced state_hash already commits them. Deriving the
            // set means a new mutation class cannot join the hash without joining the
            // exclusion, or leave the hash while staying excluded.
            assert.deepStrictEqual(lifecycle.contentParityMutableTables().sort(),
                lifecycle.hashClassTables('state_hash').sort());
            for (const t of ['stakes', 'bets', 'tokens', 'credits'])
                assert.ok(lifecycle.contentParityMutableTables().includes(t),
                    `${t} mutates in place; it must ride state_hash rather than the content window`);
        });

        it('every streamed table is content-parity covered unless it is in one of the two declared classes', function () {
            // The finding in one assertion, from this side of the twin: a replicated
            // table that is neither checked nor knowingly excluded is exactly the
            // silent gap this suite was raised for.
            const topo    = lifecycle.streamTopology();
            const streamed = [].concat(topo.blockScoped, topo.txScoped, topo.actionScoped, topo.index, topo.special);
            const mutable  = new Set(lifecycle.contentParityMutableTables());
            const orphans  = streamed.filter(t =>
                !mutable.has(t) && lifecycle.contentParityCarveOut(t, 'indexer') === null &&
                lifecycle.entry(t) === null);
            assert.deepStrictEqual(orphans, [],
                `streamed tables with no registry entry to classify them: ${orphans.join(', ')}`);
            // The carve-out must be a table that actually replicates, or the
            // declaration is describing something that no longer exists.
            for (const c of lifecycle.CONTENT_PARITY_CARVE_OUTS.filter(c => c.dbType === 'indexer'))
                assert.ok(lifecycle.entry(c.table), `${c.table} carve-out names a table with no registry entry`);
        });

        it('excluded columns name real, deliberately-unreplicated values', function () {
            // blocks.id is the local AUTO_INCREMENT surrogate the sync applier strips;
            // contract_state.state_key_bin is database-GENERATED; sync_meta.id and
            // sync_meta.logged_at are omitted from the streamed row ServerPoller builds
            // by hand, so the follower assigns its own; contract_emissions.id is the same
            // shape again, an AUTO_INCREMENT the per-block stream never carries (it names
            // execution_index/emitted_action/action_index/position explicitly). Hashing
            // any of them would turn a by-design difference into a permanent false alarm.
            // validator_rewards.id is the same class arrived at by a different route: the
            // row streams with the source id, but the RB-ANCHOR reorg restore re-INSERTs a
            // deleted loser WITHOUT naming id, so each side mints its own and
            // ClientApplier.ignoreTables makes that permanent.
            assert.deepStrictEqual(Object.keys(lifecycle.CONTENT_PARITY_EXCLUDED_COLUMNS).sort(),
                ['blocks', 'contract_emissions', 'contract_state', 'sync_meta', 'validator_rewards']);
            assert.deepStrictEqual(lifecycle.contentParityExcludedColumns('blocks'), ['id']);
            assert.deepStrictEqual(lifecycle.contentParityExcludedColumns('contract_emissions'), ['id']);
            assert.deepStrictEqual(lifecycle.contentParityExcludedColumns('contract_state'), ['state_key_bin']);
            assert.deepStrictEqual(lifecycle.contentParityExcludedColumns('sync_meta'), ['id', 'logged_at']);
            assert.deepStrictEqual(lifecycle.contentParityExcludedColumns('validator_rewards'), ['id']);
            assert.ok(/state_key_bin/.test(read('src/sql/contract_state.sql')),
                'contract_state.state_key_bin is no longer in the schema; the exclusion is stale');
            assert.ok(/id\s+BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/
                .test(read('src/sql/contract_emissions.sql')),
                'contract_emissions.id is no longer a local AUTO_INCREMENT; the exclusion is stale');
            assert.ok(/id\s+BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/
                .test(read('src/sql/validator_rewards.sql')),
                'validator_rewards.id is no longer a local AUTO_INCREMENT; the exclusion is stale');
            // The exclusion must not outlive its reason: it is justified ONLY by the
            // RB-ANCHOR restore minting the id locally on each side. If that INSERT ever
            // names id, both sides agree again and the column belongs back in the preimage.
            const rbAnchorInsert = (read('src/rollback.js')
                .match(/INSERT IGNORE INTO validator_rewards\s*\n?\s*\(([^)]*)\)/) || [])[1];
            assert.ok(rbAnchorInsert,
                'the RB-ANCHOR validator_rewards restore INSERT was not found in src/rollback.js; ' +
                're-check why validator_rewards.id is excluded from the content-parity preimage');
            assert.ok(!/\bid\b/.test(rbAnchorInsert.replace(/_id\b/g, '')),
                'the RB-ANCHOR restore now names validator_rewards.id, so the two sides no longer ' +
                'mint it locally; drop the content-parity exclusion instead of leaving it stale');
            assert.deepStrictEqual(lifecycle.contentParityExcludedColumns('actions'), [],
                'a table with nothing excluded must hash every column');
        });

        it('the two reorg-scoped lookups bound by block; the inert ones bound by id', function () {
            // index_addresses / index_tickers carry the block stamp that makes their
            // ids reorg-reproducible, so their window is a block range. The inert
            // lookups have no block column at all and ride a published id ceiling.
            for (const t of ['index_addresses', 'index_tickers'])
                assert.strictEqual(lifecycle.contentParityLookupBound(t, 'indexer'), 'block');
            for (const t of ['index_actions', 'index_statuses', 'index_transactions'])
                assert.strictEqual(lifecycle.contentParityLookupBound(t, 'indexer'), 'id');
            // The decoder schema stamps no block on its lookups.
            assert.strictEqual(lifecycle.contentParityLookupBound('index_addresses', 'decoder'), 'id');
        });
    });

    it('both state-hash conformance callers thread the (network, coin) gate pair', function () {
        // The per-chain armed maps are looked up by '<COIN>:<network>'. A caller
        // that omits coin silently computes WITHOUT the armed classes while its
        // conformance twin computes WITH them: a guaranteed divergence halt at
        // the activation height. Pin both production call sites.
        const dbSrc = read('src/db.js');
        const call = dbSrc.match(/buildStateHashData\(this, block_index, \{[\s\S]{0,700}?\}\)/);
        assert.ok(call && /coin:\s*this\.config\['COIN'\]/.test(call[0]),
            "db.js getBlockHashes must pass coin: this.config['COIN'] to buildStateHashData");
    });
});
