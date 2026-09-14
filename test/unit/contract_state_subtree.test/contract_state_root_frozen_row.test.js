/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
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
 * test/unit/contract_state_subtree.test/contract_state_root_frozen_row.test.js
 *
 * Sibling block of the contract_state_subtree.test.js suite, carrying:
 *   contract_state_root: frozen row-to-leaf mapping @regression
 *   contract_state_root: key derivation @regression
 *   contract_state_root: incremental equals full build @regression
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const M   = require('../../../src/consensus/merkle.js');
const CST = require('../../../src/consensus/contract_state_subtree.js');

const { FakeDb, EMPTY, armedAt, CHAIN, NETWORK } = require('./helpers/fake_db');

describe('contract_state_root: frozen row-to-leaf mapping @regression', function(){

    it('the SQL shape is pinned at source: binary collation, no pre-max NULL filter', function(){
        // Comments are stripped BEFORE the quoted-string scan: prose apostrophes
        // ("repo's") otherwise open a phantom string literal and the check ends up
        // grading the documentation instead of the queries.
        const src = fs.readFileSync(path.resolve(__dirname, '../../../src/consensus/contract_state_subtree.js'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const sql = src.match(/'[^']*(?:SELECT|FROM|WHERE|GROUP BY|ORDER BY)[^']*'/g).join(' ');
        // Every contract_state key reference is the utf8_bin shadow column. A plain
        // state_key would fold distinct keys under utf8_general_ci and build the SMT
        // over a folded key set: a fork the stub above cannot see. Output ALIASES
        // (`state_key_bin AS state_key`) are not column references and are stripped
        // before the check, so this pins what is read, not what it is called.
        const referenced = sql.replace(/AS state_key\b/g, '');
        assert.ok(!/\bstate_key\b(?!_bin)/.test(referenced),
            'contract_state queries must reference state_key_bin, never state_key');
        assert.ok(/GROUP BY contract_index, state_key_bin/.test(sql), 'full build must group on the binary shadow');
        assert.ok(/ORDER BY id DESC LIMIT 1/.test(sql), 'latest-row read must be by descending id');
        // The NULL test lives in JS, AFTER the max. If this ever appears in the SQL
        // it must be in an OUTER position; the safe rule is that it appears nowhere.
        assert.ok(!/state_value IS NOT NULL/.test(sql),
            'a state_value IS NOT NULL predicate must not enter these queries: applied before MAX(id) it resurrects deleted keys');
    });
});

describe('contract_state_root: key derivation @regression', function(){

    it('is domain-separated from the balance and escrow key domains', function(){
        const k = M.toHex(M.contractStateKey(CHAIN, NETWORK, 7, 'k'));
        assert.notStrictEqual(k, M.toHex(M.balanceKey(CHAIN, NETWORK, '7', 'k')));
        assert.notStrictEqual(k, M.toHex(M.escrowKey(CHAIN, NETWORK, '7', 'k')));
        assert.strictEqual(k, M.toHex(M.smtKey('XCHAIN_CST', [CHAIN, NETWORK, '7', 'k'])));
    });

    it('separates chain, network, contract and key (no field can be smeared into another)', function(){
        const base = M.toHex(M.contractStateKey('BTC', 'regtest', 7, 'k'));
        for(const other of [ M.contractStateKey('LTC', 'regtest', 7, 'k'),
                             M.contractStateKey('BTC', 'testnet', 7, 'k'),
                             M.contractStateKey('BTC', 'regtest', 8, 'k'),
                             M.contractStateKey('BTC', 'regtest', 7, 'k2'),
                             M.contractStateKey('BTC', 'regtest', 77, ''),
                             M.contractStateKey('BTC', 'regtest', 7, '7k') ])
            assert.notStrictEqual(base, M.toHex(other));
    });

    it('contract_index type does not change the key (driver bigint config is not consensus)', function(){
        // MariaDB drivers return BIGINT UNSIGNED as a number, a string or a BigInt
        // depending on options the two twins are not obliged to share. All three
        // must key identically or the follower halts on a root only it computes.
        const asNumber = M.toHex(M.contractStateKey(CHAIN, NETWORK, 7, 'k'));
        const asString = M.toHex(M.contractStateKey(CHAIN, NETWORK, '7', 'k'));
        const asBigInt = M.toHex(M.contractStateKey(CHAIN, NETWORK, 7n, 'k'));
        assert.strictEqual(asString, asNumber);
        assert.strictEqual(asBigInt, asNumber);
    });

    it('a 0x00-bearing state_key still throws, and that is the known surface', function(){
        // The encoding route that would have made this total was closed by operator
        // decision (repins the VM NUL rejection instead), so this throw is
        // load-bearing documentation: Stage A may not arm until those gates are
        // ARMED, because the arming block's full build reads the whole table.
        assert.throws(() => M.contractStateKey(CHAIN, NETWORK, 7, 'a\u0000b'), /0x00/);
    });
});

describe('contract_state_root: incremental equals full build @regression', function(){

    // A block's writes land BEFORE its root is computed, and no later block's
    // rows exist yet. That ordering is production's, and it is a real
    // precondition rather than a fixture convenience: latestStateValue reads the
    // newest row for a key with no as-of-height filter, so computing a
    // historical block's root while later rows exist would read the future. The
    // balances path (getNetBalance sums all credits/debits) has the identical
    // property, and every caller of both satisfies it because roots are computed
    // once, inside the block that produces them.
    async function runChain(db, schedule, from, to){
        for(let h = from; h <= to; h++){
            for(const w of (schedule[h] || [])) db.write(h, w[0], w[1], w[2]);
            db.storeRoot(h, await CST.resolveContractStateRoot(db, db.smt(), CHAIN, NETWORK, h));
        }
        return db.roots.get(to).contract_state_root;
    }

    const SCHEDULE = {
        100: [[7, 'alpha', '"a1"'], [7, 'beta', '"b1"']],
        101: [[7, 'alpha', '"a2"'],                       // overwrite
              [8, 'alpha', '"other"']],                   // same key, different contract
        102: [[7, 'beta',  null]],                        // delete
        103: [[7, 'gamma', '']],                          // the defensive empty-string case
        104: [[8, 'alpha', '"other2"']]
    };

    async function advance(db, from, to){ return runChain(db, {}, from, to); }

    it('threading block by block lands on the same root as one full build', async function(){
        const db = new FakeDb();
        db.storeRoot(99, EMPTY);                     // prior root exists, so we thread
        const threaded = await runChain(db, SCHEDULE, 100, 104);
        const full     = await CST.buildFullContractStateRoot(db, db.smt(), CHAIN, NETWORK);
        assert.strictEqual(threaded, full);
        assert.notStrictEqual(threaded, EMPTY, 'the fixture must actually populate a tree');
    });

    it('a block that deletes the last live key returns the tree to EMPTY', async function(){
        const db = new FakeDb();
        db.write(100, 7, 'only', '"v"');
        db.storeRoot(99, EMPTY);
        const at100 = await advance(db, 100, 100);
        assert.notStrictEqual(at100, EMPTY);
        db.write(101, 7, 'only', null);
        const at101 = await advance(db, 101, 101);
        assert.strictEqual(at101, EMPTY, 'delete-on-tombstone must collapse back to the empty root');
    });

    it('a block touching nothing leaves the root unchanged', async function(){
        const db = new FakeDb();
        db.write(100, 7, 'k', '"v"');
        db.storeRoot(99, EMPTY);
        const at100 = await advance(db, 100, 100);
        const at101 = await advance(db, 101, 101);
        assert.strictEqual(at101, at100);
    });

    it('no prior root full-builds instead of threading from EMPTY (the silent-fork refusal)', async function(){
        // Snapshot bootstrap: the tables are fully populated but there is no
        // block-1 row. Threading from EMPTY would commit a root forked from a
        // from-genesis node; the full build is the same root that node has.
        const db = new FakeDb();
        await runChain(db, SCHEDULE, 100, 104);
        db.roots.clear();                            // snapshot copies tables, not root history
        const seeded = await CST.resolveContractStateRoot(db, db.smt(), CHAIN, NETWORK, 105);
        const full   = await CST.buildFullContractStateRoot(db, db.smt(), CHAIN, NETWORK);
        assert.strictEqual(seeded, full);
        assert.notStrictEqual(seeded, EMPTY);
    });
});
