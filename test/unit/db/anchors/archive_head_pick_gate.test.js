'use strict';

const assert = require('assert');
const sinon = require('sinon');

const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const { UNARMED } = require('../../../../src/protocol_changes/core.js');
const {
    archiveHeadPickPredicate,
    foldArchiveHeadFloor,
} = require('../../../../src/db/anchors/archive_head_pick.js');
const anchorMethods = require('../../../../src/db/anchors/index.js');
const Database = require('../../../../src/db/index.js');
const anchorSql = require('../../../../src/db/anchor_sql.js');
const AnchorRecovery = require('../../../../bin/recovery.js');

const FOLD_KEY = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';

function stubFoldFloor(height) {
    const read = gateRegistry.registry.read.bind(gateRegistry.registry);
    sinon.stub(gateRegistry.registry, 'read').callsFake((key) => {
        if(key !== FOLD_KEY) return read(key);
        return Object.freeze({ mainnet: UNARMED, testnet: UNARMED, regtest: height });
    });
}

function stubPostArmFoldFloor(height) {
    const read = gateRegistry.registry.read.bind(gateRegistry.registry);
    sinon.stub(gateRegistry.registry, 'read').callsFake((key) => {
        if(key !== FOLD_KEY) return read(key);
        return Object.freeze({
            mainnet: UNARMED, testnet: UNARMED, regtest: 0,
            'BTC:testnet': height, 'LTC:testnet': height, 'DOGE:testnet': height,
        });
    });
}

function assertPick(sql, alias) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pick = new RegExp(
        escaped + '\\.match_batch_seq IS NOT NULL AND \\(\s*' +
        escaped + '\\.version = 1 OR \\(\s*' +
        escaped + '\\.version = 3 AND ' +
        escaped + '\\.chain IS NULL AND ' +
        escaped + '\\.block_index_doge >= \\?\\s*\\)\\s*\\)'
    );
    assert.match(sql, pick);
    assert.doesNotMatch(sql, /version\s*<>\s*2/i);
}

async function capture(method, receiver, args) {
    const calls = [];
    const db = Object.assign({
        config: { NETWORK: 'regtest' },
        doQuery: async (sql, params) => {
            calls.push({ sql, params });
            return [];
        },
    }, receiver);
    await method.apply(db, args);
    return calls;
}

function assertBoundCall(call, sql, params, floorIndex, floor) {
    assert.strictEqual(call.sql, sql);
    assert.strictEqual((call.sql.match(/\?/g) || []).length, call.params.length);
    assert.deepStrictEqual(call.params, params);
    assert.strictEqual(call.params[floorIndex], floor);
}

describe('archive-head canonical pick fold gate', function () {
    afterEach(function () { sinon.restore(); });

    it('keeps public networks unarmed and fails unknown networks closed', function () {
        assert.ok(foldArchiveHeadFloor('testnet') >= UNARMED);
        assert.ok(foldArchiveHeadFloor('mainnet') >= UNARMED);
        assert.strictEqual(foldArchiveHeadFloor('unknown'), UNARMED);
    });

    it('maps an unpinned network floor to the unarmed sentinel', function () {
        stubFoldFloor(null);
        assert.strictEqual(foldArchiveHeadFloor('regtest'), UNARMED);
    });

    it('resolves the regtest floor from the same registry read as activeAt', function () {
        const height = 73;
        stubFoldFloor(height);
        assert.strictEqual(foldArchiveHeadFloor('regtest'), height);
        assert.strictEqual(gateRegistry.activeAt(FOLD_KEY, 'regtest', null, height - 1, null), false);
        assert.strictEqual(gateRegistry.activeAt(FOLD_KEY, 'regtest', null, height, null), true);
    });

    it('resolves the DOGE floor from the post-arm testnet row', function () {
        const height = 67961578;
        stubPostArmFoldFloor(height);
        assert.strictEqual(foldArchiveHeadFloor('testnet', 'DOGE'), height);
        assert.strictEqual(gateRegistry.activeAt(
            FOLD_KEY, 'testnet', 'DOGE', height - 1, null), false);
        assert.strictEqual(gateRegistry.activeAt(
            FOLD_KEY, 'testnet', 'DOGE', height, null), true);
    });

    it('builds only the version-1 or gated folded-head predicate', function () {
        const sql = archiveHeadPickPredicate('head');
        assertPick(sql, 'head');
        assert.strictEqual((sql.match(/\?/g) || []).length, 1);
    });

    it('binds the floor before batch and optional author in both head lookups', async function () {
        stubFoldFloor(73);
        const plain = await capture(anchorMethods.getAnchorV1ByBatchSeq, {}, [42]);
        const scoped = await capture(anchorMethods.getAnchorV1ByBatchSeq, {}, [42, 'DPublisher']);
        assertPick(plain[0].sql, 'a');
        assertPick(scoped[0].sql, 'a');
        assert.deepStrictEqual(plain[0].params, [73, 42]);
        assert.deepStrictEqual(scoped[0].params, [73, 42, 'DPublisher']);
    });

    it('places the floor placeholder correctly in every shared canonical-head SQL', function () {
        for(const name of ['ARCHIVE_HEAD_AUTHOR_SQL', 'ARCHIVE_CHUNK_SET_SQL', 'ARCHIVE_HEAD_GATE_SQL']) {
            assertPick(anchorSql[name], 'h');
        }
        const author = anchorSql.ARCHIVE_HEAD_AUTHOR_SQL;
        assert.ok(author.indexOf('block_index_doge >= ?') < author.indexOf('h.match_batch_seq = ?'));
        const chunks = anchorSql.ARCHIVE_CHUNK_SET_SQL;
        assert.ok(chunks.indexOf('c.match_batch_seq = ?') < chunks.indexOf('block_index_doge >= ?'));
        assert.ok(chunks.indexOf('block_index_doge >= ?') < chunks.indexOf('h.match_batch_seq = ?'));
        const gate = anchorSql.ARCHIVE_HEAD_GATE_SQL;
        assert.ok(gate.indexOf('block_index_doge >= ?') < gate.indexOf('h.match_batch_seq = ?'));
    });

    it('embeds the author query exactly once in the shared chunk query', function () {
        const embedded = '(' + anchorSql.ARCHIVE_HEAD_AUTHOR_SQL + ')';
        assert.strictEqual(anchorSql.ARCHIVE_CHUNK_SET_SQL.split(embedded).length - 1, 1);
    });

    it('binds the embedded author floor in the installed chunk read', async function () {
        stubFoldFloor(73);
        const calls = await capture(Database.prototype.getAnchorChunks, {}, [42]);
        assertBoundCall(calls[0], anchorSql.ARCHIVE_CHUNK_SET_SQL, [42, 73, 42], 1, 73);
    });

    it('uses each recovery row network for gate and chunk floor bindings', async function () {
        stubFoldFloor(73);
        const calls = [];
        const db = {
            doQuery: async (sql, params) => {
                calls.push({ sql, params });
                return [];
            },
        };
        const recovery = new AnchorRecovery(db, { log: () => {} });
        const head = { match_batch_seq: 42, network: 'regtest', source: 'DPublisher',
                       total_chunks: 2, archive_b64: '' };
        await assert.rejects(() => recovery.verifyBatch(head), /incomplete batch/);
        assertBoundCall(calls[0], anchorSql.ARCHIVE_HEAD_GATE_SQL, [73, 42], 0, 73);
        assertBoundCall(calls[1], anchorSql.ARCHIVE_CHUNK_SET_SQL, [42, 73, 42], 1, 73);
    });
});
