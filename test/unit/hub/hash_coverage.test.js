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
 * test/unit/hub/hash_coverage.test.js
 *
 * Hash-coverage guard: binds the per-table `hashed` declarations in the
 * table-lifecycle registry (src/hub/table_lifecycle.js) to the code that actually
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
const { concatSrcTreeFiles } = require('../../helpers/src_tree_files');

const lifecycle = require('../../../src/hub/table_lifecycle.js');
const stateHash = require('../../../src/stateHash.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../../..', rel), 'utf8');

// The state commitment is an entry plus a parts directory (src/stateCommitment/),
// and the node-store SQL that names state_tree_nodes lives in the persistent_smt
// part, so a pin on the feature reads the entry and every part as one text: the
// entry alone would satisfy a table-name pin on its header prose.
const readStateCommitment = () => read('src/stateCommitment.js') +
    concatSrcTreeFiles(path.join(__dirname, '../../..', 'src', 'stateCommitment'));

// The Database class is a directory of per-family mixins, so a scan over the class
// concatenates every file in a fixed order instead of reading one path.
const readDb = () => {
    const dir = path.join(__dirname, '../../..', 'src', 'db');
    return concatSrcTreeFiles(dir);
};

// The consensus block-hash preimage gathering lives in db/actions.js as one method
// per query, declared in gathering order, and getBlockHashes composes them. Slice
// the run of gathering methods (the first, credits, through the last hash-class
// table, withdrawals; the previous-block-hash read that follows is not a hash
// class) so the FROM-table assertions below cannot accidentally match unrelated
// SQL elsewhere in the Database class.
function blockHashBody(){
    const src   = readDb();
    const start = src.indexOf('async getBlockHashCreditRows(');
    const end   = src.indexOf('async getPreviousBlockHashes(', start);
    assert.ok(start !== -1 && end > start, 'db/actions.js gathering methods not found; update this guard\'s slicing');
    // Code only: the FROM-table pins below must bind to the SQL, and a gather whose
    // header comment says "data from escrows" would otherwise satisfy them with the
    // query reading any table at all.
    return src.slice(start, end).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

describe('Hash coverage guard @regression', function () {

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
});

describe('Hash coverage guard @regression', function () {
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
            'tokens',         // supply-refresh class (stale-supply gap closure; flag-day gated; structural binding below)
            'bet_feeds',      // BET latch + terminal-flip class (flag-day gated; structural binding below)
            'bets',           // BET settlement-flip class (same flag-day; structural binding below)
        ]);
        assert.deepStrictEqual(
            lifecycle.hashClassTables('state_hash').sort(),
            [...fromCode].sort(),
            'state_hash declarations in table_lifecycle.js and the classes gathered by stateHash.js have drifted; ' +
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
        const db      = readDb();
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
                `db.js ${name} mutates attests in place but the attests registry note in src/hub/table_lifecycle.js ` +
                `does not name it; state its hash / updated_rows / rollback coverage there (and copy to the sync twin)`);
        }
    });
});

describe('Hash coverage guard @regression', function () {
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
        const src = readStateCommitment();
        for (const t of ['balances', 'state_tree_roots', 'state_tree_nodes']) {
            assert.ok(src.indexOf(t) !== -1,
                `the state commitment (entry plus parts) no longer references ${t}; the state_commitment declaration is stale`);
        }
    });

    it('escrow_leaf_journal state_commitment class: the leaf builder reads it behind the arming gate', function () {
        // Structural binding for the escrow_leaf_journal declaration, mirroring the
        // gated-class bindings above (poll_finalize / token_supply / bet_status): the
        // journal is only consensus-visible because escrow_leaf_subtree.js reads it into
        // balances_root, and stateCommitment.js applies that behind
        // ESCROW_LOCKED_LEAF_ACTIVATION. If either half moves, the declaration is stale.
        const leaf = read('src/consensus/escrow_leaf_subtree.js');
        assert.ok(/FROM escrow_leaf_journal j/.test(leaf),
            'escrow_leaf_subtree.js no longer reads escrow_leaf_journal; its state_commitment declaration is stale');
        const commit = read('src/stateCommitment.js');
        assert.ok(commit.indexOf('applyEscrowLeaves') !== -1,
            'stateCommitment.js no longer applies the escrow leaves into balances_root');
        const act = require('../../../src/state_subtree_activation.js');
        assert.ok(Number.isFinite(Number(act.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'])),
            'ESCROW_LOCKED_LEAF_ACTIVATION lost its armed BTC:regtest height; re-check the declared coverage');
    });
});

describe('Hash coverage guard @regression', function () {
    it('quorum class declarations are pinned to the hub-mirrored federation-signed tables', function () {
        assert.deepStrictEqual(lifecycle.hashClassTables('quorum').sort(),
            ['bridge_transfers', 'capability_snapshots', 'cross_chain_calls', 'cross_chain_matches',
             'policy_snapshots', 'price_snapshots', 'state_checkpoints'],
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
});

describe('Hash coverage guard @regression', function () {
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
});

describe('Hash coverage guard @regression', function () {
    it('both state-hash conformance callers thread the (network, coin) gate pair', function () {
        // The per-chain armed maps are looked up by '<COIN>:<network>'. A caller
        // that omits coin silently computes WITHOUT the armed classes while its
        // conformance twin computes WITH them: a guaranteed divergence halt at
        // the activation height. Pin both production call sites.
        const dbSrc = readDb();
        const call = dbSrc.match(/buildStateHashData\(this, block_index, \{[\s\S]{0,700}?\}\)/);
        assert.ok(call && /coin:\s*this\.config\['COIN'\]/.test(call[0]),
            "db.js getBlockHashes must pass coin: this.config['COIN'] to buildStateHashData");
    });
});
