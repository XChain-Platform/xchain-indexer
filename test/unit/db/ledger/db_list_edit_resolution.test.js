/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/db/ledger/db_list_edit_resolution.test.js
 *
 * a LIST edit writes its resulting items under the EDIT's own
 * action_index and never touches the parent's list_items rows. Every consumer
 * pins a list by its CREATE action_index (bet_feeds.allow_list/block_list,
 * tokens.allow_list/block_list, orders/swaps/dispensers, AIRDROP), so
 * getList(createIndex) returned create-time membership forever: on-chain lists
 * were effectively immutable and a members-only market could neither revoke nor
 * grant membership after create.
 *
 * getList now resolves a reference to the HEAD of the list's edit chain (the
 * newest VALID action in it), which is exactly the current membership because
 * every valid edit persists a complete snapshot rather than a delta. Gated per
 * chain (list_edit_resolution_activation.js) because it changes which actions
 * the allow/block gates accept, hence historical replay.
 *
 * These tests drive the real Database.getList against an in-memory `lists` /
 * `list_items` store served through a stubbed doQuery, so they exercise the
 * actual SQL the resolver emits.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');
const gateRegistry      = require('../../../../src/consensus/gate_registry');

const LIST_HEAD_FOLLOWS_EDIT_CHAIN_KEY = 'list_head_follows_edit_chain.LIST_HEAD_FOLLOWS_EDIT_CHAIN';
const TOKEN_GATE_LIST_AT_BLOCK_KEY = 'token_gate_list_at_block.TOKEN_GATE_LIST_AT_BLOCK';

const ADDR_A = 'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz';
const ADDR_B = 'mk7MdP3qzVkgyjaYNR2sUY8Ggn4DWxt2KS';
const ADDR_C = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

// A Database backed by a tiny in-memory model of the list tables.
//   rows:  [{ action_index, type, list_action_index, status, block_index }]
//   items: { action_index: [item, ...] }
function dbWithLists(rows, items) {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    const rowFor = (idx) => rows.find(r => String(r.action_index) === String(idx));
    sinon.stub(db, 'doQuery').callsFake((query, args) => {
        calls.push({ query, args });
        const q = query.replace(/\s+/g, ' ');
        if (/SELECT type FROM lists WHERE action_index=\?/i.test(q)) {
            const row = rowFor(args[0]);
            return Promise.resolve(row ? [{ type: row.type }] : []);
        }
        if (/SELECT l\.type FROM lists l INNER JOIN index_statuses/i.test(q)) {
            const row = rowFor(args[0]);
            return Promise.resolve(row && row.status === 'valid' ? [{ type: row.type }] : []);
        }
        if (/SELECT list_action_index FROM lists WHERE action_index=\?/i.test(q)) {
            const row = rowFor(args[0]);
            return Promise.resolve(row ? [{ list_action_index: row.list_action_index }] : []);
        }
        if (/FROM lists l INNER JOIN index_statuses/i.test(q)) {
            if (/SELECT\s+l\.action_index,\s+s\.status/i.test(q)) {
                const children = rows
                    .filter(r => String(r.list_action_index) === String(args[0]))
                    .filter(r => args.length < 2 || r.block_index === undefined || r.block_index <= args[1])
                    .sort((a, b) => b.action_index - a.action_index);
                return Promise.resolve(children.map(r => ({ action_index: r.action_index, status: r.status })));
            }
            const heads = rows
                .filter(r => r.status === 'valid' && String(r.list_action_index) === String(args[0]))
                .sort((a, b) => b.action_index - a.action_index);
            return Promise.resolve(heads.length ? [{ action_index: heads[0].action_index }] : []);
        }
        if (/FROM list_items l/i.test(q)) {
            const list = items[String(args[0])] || [];
            return Promise.resolve(list.slice().sort().map(item => ({ item })));
        }
        return Promise.resolve([]);
    });
    db._calls = calls;
    return db;
}

// The canonical fixture: create 2020 holds [A], edit 2021 REMOVEs A (the exact
// shape probed live on BTC regtest in the report).
function removeFixture() {
    return dbWithLists(
        [
            { action_index: 2020, type: 2, list_action_index: null, status: 'valid' },
            { action_index: 2021, type: 2, list_action_index: 2020, status: 'valid' }
        ],
        { '2020': [ADDR_A], '2021': [] }
    );
}

function legacyEditOfEditFixture() {
    return dbWithLists(
        [
            { action_index: 10, type: 2, list_action_index: null, status: 'valid' },
            { action_index: 11, type: 2, list_action_index: 10,   status: 'valid' },
            { action_index: 12, type: 2, list_action_index: 11,   status: 'valid' }
        ],
        { '10': [ADDR_A], '11': [ADDR_A, ADDR_B], '12': [ADDR_C] }
    );
}

afterEach(function () { sinon.restore(); });

describe('db.getList() LIST edit resolution @regression @tier1', function () {
    it('legacy path (no block context) still reads the create index verbatim', async function () {
        const db = removeFixture();
        // No block_index means no gate evaluation, so historical replay of a block
        // processed before the flag day stays byte-identical.
        const list = await db.getList(2020);
        assert.deepStrictEqual(list, [ADDR_A], 'the legacy read must return create-time membership');
    });

    it('a REMOVE reaches a consumer that pinned the CREATE index', async function () {
        const db = removeFixture();
        const list = await db.getList(2020, 100);
        assert.deepStrictEqual(list, [], 'the removed member must be gone from the pinned list');
    });

    it('an ADD after create reaches the pinned CREATE index', async function () {
        const db = dbWithLists(
            [
                { action_index: 10, type: 2, list_action_index: null, status: 'valid' },
                { action_index: 11, type: 2, list_action_index: 10,   status: 'valid' }
            ],
            { '10': [ADDR_A], '11': [ADDR_A, ADDR_B] }
        );
        const list = await db.getList(10, 100);
        assert.deepStrictEqual(list.slice().sort(), [ADDR_A, ADDR_B].sort());
    });

    it('the NEWEST valid edit wins, so a chain of edits composes', async function () {
        const db = dbWithLists(
            [
                { action_index: 10, type: 2, list_action_index: null, status: 'valid' },
                { action_index: 11, type: 2, list_action_index: 10,   status: 'valid' },
                { action_index: 12, type: 2, list_action_index: 10,   status: 'valid' }
            ],
            { '10': [ADDR_A], '11': [ADDR_A, ADDR_B], '12': [ADDR_B] }
        );
        const list = await db.getList(10, 100);
        assert.deepStrictEqual(list, [ADDR_B], 'membership is the newest edit snapshot, not the create');
    });
});

describe('db.getList() chained edit resolution @regression @tier1', function () {
    it('below LIST_HEAD_FOLLOWS_EDIT_CHAIN keeps the direct-child head', async function () {
        const db = legacyEditOfEditFixture();
        sinon.stub(gateRegistry, 'activeAt').callThrough()
            .withArgs(LIST_HEAD_FOLLOWS_EDIT_CHAIN_KEY, 'regtest', 'BTC', 100, null).returns(false);
        const list = await db.getList(10, 100);
        assert.deepStrictEqual(list.slice().sort(), [ADDR_A, ADDR_B].sort());
    });

    it('at LIST_HEAD_FOLLOWS_EDIT_CHAIN resolves the deepest legacy edit', async function () {
        const db = legacyEditOfEditFixture();
        const list = await db.getList(10, 100);
        assert.deepStrictEqual(list, [ADDR_C]);
    });

    it('registers LIST_HEAD_FOLLOWS_EDIT_CHAIN with the deployment heights', function () {
        assert.deepStrictEqual(gateRegistry.get(LIST_HEAD_FOLLOWS_EDIT_CHAIN_KEY), {
            mainnet: 9999999999,
            'BTC:testnet': 155001,
            'LTC:testnet': 4906040,
            'DOGE:testnet': 67962387,
            testnet: 9999999999,
            regtest: 0,
        });
    });

    it('an INVALID edit is never the head (it writes no items, so it would empty the list)', async function () {
        const db = dbWithLists(
            [
                { action_index: 10, type: 2, list_action_index: null, status: 'valid' },
                { action_index: 11, type: 2, list_action_index: 10,   status: 'valid' },
                { action_index: 12, type: 2, list_action_index: 10,   status: 'invalid: EDIT (unknown)' }
            ],
            { '10': [ADDR_A], '11': [ADDR_A, ADDR_B], '12': [] }
        );
        const list = await db.getList(10, 100);
        assert.deepStrictEqual(list.slice().sort(), [ADDR_A, ADDR_B].sort(),
            'an invalid edit must leave the previous head standing');
    });

    it('getListAtBlock resolves a long branched chain without future membership', async function () {
        const rows = [];
        const items = {};
        for(let action_index = 100; action_index <= 120; action_index++){
            rows.push({
                action_index,
                type: 2,
                list_action_index: action_index === 100 ? null : action_index - 1,
                status: 'valid',
                block_index: action_index
            });
            items[String(action_index)] = ['member-' + action_index];
        }
        rows.push({
            action_index: 121,
            type: 2,
            list_action_index: 100,
            status: 'valid',
            block_index: 120
        });
        items['121'] = ['member-121'];
        const db = dbWithLists(rows, items);

        for(const block_index of [120, 121]){
            assert.deepStrictEqual(
                await db.getListAtBlock(120, block_index),
                await db.getList(120, block_index),
                'height ' + block_index + ' must agree with the current list reader'
            );
        }

        assert.deepStrictEqual(await db.getListAtBlock(120, 100), ['member-100']);
        assert.deepStrictEqual(await db.getListAtBlock(120, 102), ['member-102']);

        db._calls.length = 0;
        await db.getListAtBlock(120, 120);
        const parentReads = db._calls.filter(c => /SELECT list_action_index FROM lists/i.test(c.query));
        assert.strictEqual(parentReads.length, 21, 'the reference reaches CREATE in one parent walk');
    });
});

describe('db.getList() LIST edit resolution @regression @tier1', function () {
    it('resolving by an EDIT index gives the same membership as the CREATE index', async function () {
        const db = removeFixture();
        const byCreate = await db.getList(2020, 100);
        const byEdit   = await db.getList(2021, 100);
        assert.deepStrictEqual(byEdit, byCreate, 'both references must resolve to the same head');
    });

    it('an unknown reference is still an empty list', async function () {
        const db = removeFixture();
        const list = await db.getList(999999, 100);
        assert.deepStrictEqual(list, [], 'no lists row means no list');
    });

    it('a self-referencing (malformed) chain terminates instead of spinning', async function () {
        const db = dbWithLists(
            [{ action_index: 5, type: 2, list_action_index: 5, status: 'valid' }],
            { '5': [ADDR_C] }
        );
        const list = await db.getList(5, 100);
        assert.deepStrictEqual(list, [ADDR_C]);
    });

    it('the resolved branch query is still the binary-collated ordered read (3c05dcb9)', async function () {
        const db = removeFixture();
        await db.getList(2020, 100);
        const hit = db._calls.find(c => /FROM\s+list_items/i.test(c.query));
        assert.ok(hit, 'getList did not emit its list_items branch query');
        assert.match(hit.query.replace(/\s+/g, ' '), /ORDER BY a\.address COLLATE utf8_bin ASC/,
            'edit resolution must not drop the consensus ordering');
        assert.strictEqual(String(hit.args[0]), '2021', 'the branch query must read the resolved head');
    });

    it('getListRootIndex walks an edit-of-edit chain back to the create', async function () {
        const db = dbWithLists(
            [
                { action_index: 10, type: 2, list_action_index: null, status: 'valid' },
                { action_index: 11, type: 2, list_action_index: 10,   status: 'valid' },
                { action_index: 12, type: 2, list_action_index: 11,   status: 'valid' }
            ],
            {}
        );
        assert.strictEqual(await db.getListRootIndex(12), 10);
        assert.strictEqual(await db.getListRootIndex(10), 10);
    });

});

describe('db.isActionAllowed() token LIST block pin @regression @tier1', function () {
    function tokenGateDb(){
        const db = removeFixture();
        sinon.stub(db, 'getTokenInfo').resolves({ ALLOW_LIST: 2020, BLOCK_LIST: null });
        sinon.stub(db, 'isTickSleeping').resolves(false);
        sinon.stub(db, 'isAddressSleeping').resolves(false);
        return db;
    }

    it('keeps create-time membership below TOKEN_GATE_LIST_AT_BLOCK', async function () {
        const activeAt = sinon.stub(gateRegistry, 'activeAt').callThrough();
        activeAt.withArgs(TOKEN_GATE_LIST_AT_BLOCK_KEY).returns(false);
        const db = tokenGateDb();

        assert.strictEqual(await db.isActionAllowed(ADDR_A, 'TEST', 100), true);
        assert.ok(db.getTokenInfo.calledWith('TEST', undefined), 'legacy token state lookup stays unbounded');
        const listRead = db._calls.find(c => /FROM\s+list_items/i.test(c.query));
        assert.strictEqual(String(listRead.args[0]), '2020', 'legacy lookup reads the create membership');
    });

    it('applies the edited membership when TOKEN_GATE_LIST_AT_BLOCK is active', async function () {
        const db = tokenGateDb();

        assert.strictEqual(await db.isActionAllowed(ADDR_A, 'TEST', 100), false);
        assert.ok(db.getTokenInfo.calledWith('TEST', 100), 'token state lookup is pinned to the action block');
        const listRead = db._calls.find(c => /FROM\s+list_items/i.test(c.query));
        assert.strictEqual(String(listRead.args[0]), '2021', 'the action-block lookup reads the edited membership');
    });
});


describe('getList() call sites carry block context (ratchet) @regression @tier1', function () {

    it('no getList() call in src/ omits the block_index argument', function () {
        const fs   = require('fs');
        const path = require('path');
        const root = path.join(__dirname, '..', '..', '..', '..', 'src');
        const files = [];
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name === 'tmp') continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.js')) files.push(full);
            }
        })(root);

        const offenders = [];
        for (const file of files) {
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            lines.forEach((line, i) => {
                // Prose mentions of getList(...) in the surrounding rationale
                // comments are not call sites.
                const trimmed = line.trim();
                if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
                // Match a getList( call whose argument list has no top-level comma.
                // The definition itself and getListType/getListRootIndex/
                // getListHeadIndex are not call sites of the gated reader.
                const m = line.match(/(?<![A-Za-z])getList\(([^()]*)\)/);
                if (!m) return;
                if (/async\s+getList\(/.test(line)) return;
                if (m[1].includes(',')) return;
                offenders.push(path.relative(root, file) + ':' + (i + 1) + ' ' + line.trim());
            });
        }
        assert.deepStrictEqual(offenders, [],
            'every getList() call must pass block_index, or the flag day silently stays inert there');
    });
});

describe('isActionAllowed() call sites carry block context (ratchet) @regression @tier1', function () {
    it('no isActionAllowed() caller omits the block_index argument', function () {
        const fs   = require('fs');
        const path = require('path');
        const root = path.join(__dirname, '..', '..', '..', '..', 'src');
        const files = [];
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name === 'tmp') continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.js')) files.push(full);
            }
        })(root);

        const offenders = [];
        for (const file of files) {
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            lines.forEach((line, i) => {
                const trimmed = line.trim();
                if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
                const m = line.match(/(?<![A-Za-z])isActionAllowed\(([^()]*)\)/);
                if (!m || /async\s+isActionAllowed\(/.test(line)) return;
                if (m[1].split(',').length >= 3) return;
                offenders.push(path.relative(root, file) + ':' + (i + 1) + ' ' + line.trim());
            });
        }
        assert.deepStrictEqual(offenders, [],
            'every isActionAllowed() caller must pass the action block_index');
    });

});
