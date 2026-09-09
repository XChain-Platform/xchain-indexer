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
 * test/unit/actions/anchor-retired-wire-replay.test.js
 *
 * A from-genesis replay must get PAST the pre-activation anchors, not merely
 * reject them. Below ANCHOR_ACTIVATION the retired wires (the per-chain v5, the
 * old v6 archive head, the v7 bundle) are 'invalid: ANCHOR before activation'
 * and are recorded through the fall-through archive-head parser, whose
 * positional walk of a v5/v7 wire lands hashes and chain names in the numeric
 * slots. createAnchorAction used to coerce those with Number(), producing NaN,
 * which the mariadb driver serializes as the bare literal `NaN`: the INSERT
 * failed on every retry and the block never parsed. Measured on the public
 * testnet 2026-09-09: a v0.16.0 indexer replaying TDOGE from its first block
 * looped forever at 67856088 (action 12, the first v5 anchor), so no fresh node
 * could sync DOGE testnet from genesis. This test drives the retired v5 wire
 * shape through the REAL parser and the REAL writer (doQuery stubbed) and
 * asserts every bound value is SQL-safe.
 */
'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const { getTestConfig } = require('../../fixtures/config');
const Utility  = require('../../../src/utility');
const Database = require('../../../src/db');
const Anchor   = require('../../../src/actions/anchor.js');
const aact     = require('../../../src/anchor_activation.js');

const HASH   = (c) => c.repeat(64);
const PUBKEY = 'a'.repeat(64);
const SIG    = '1'.repeat(128);

// The retired per-chain v5 layout, exactly as the deleted formats[5] read it
// (xchain-indexer 8a553a51 and earlier):
//   VERSION|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH
//   |CHECKPOINT_SEQ|SNAPSHOT_BLOCK|STATE_ROOT|STATE_ROOT_VERSION|BLOCK_MERKLE_ROOT
//   |BLOCK_MERKLE_VERSION|SIG_COUNT|PUBKEY|SIG|...|PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|...
// Values shaped like TDOGE action 12 (seq 150174, DOGE testnet 67856002).
function v5Params() {
    return ['5', 'DOGE', 'testnet', '67856002', HASH('0'), HASH('1'), HASH('2'), HASH('3'),
            '150174', '150174', HASH('d'), '2', HASH('e'), '1', '1', PUBKEY, SIG,
            PUBKEY, '1', PUBKEY, SIG];
}

// A real Database with only the transport stubbed, so the arg list the writer
// binds is the one production would send.
function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    return new Database('127.0.0.1', 3306, 'xchain_doge_testnet', 'u', 'p', indexer);
}
async function runCreate(db, data) {
    sinon.stub(db, 'createStatus').resolves(7);
    const doQuery = sinon.stub(db, 'doQuery');
    doQuery.callsFake(async (sql) => (/^\s*SELECT/i.test(sql) ? [] : { affectedRows: 1 }));
    await db.createAnchorAction(data);
    const insert = doQuery.getCalls().find(c => /INSERT INTO anchor_actions/.test(c.args[0]));
    assert.ok(insert, 'the invalid row is still recorded (an INSERT was issued)');
    return insert.args[1];
}
// Column shapes, in INSERT arg order (src/sql/anchor_actions.sql): [max integer] or [max chars].
const U8 = 255, U32 = 4294967295, U64 = Number.MAX_SAFE_INTEGER, TEXT = 16777215;
const SHAPE = [
    ['section_index', U8], ['version', U8], ['chain', 10], ['network', 20], ['block_index', U64],
    ['block_hash', 64], ['ledger_hash', 64], ['actions_hash', 64], ['contract_hash', 64],
    ['checkpoint_seq', U64], ['snapshot_block', U64], ['state_root', 64], ['state_root_version', U8],
    ['block_merkle_root', 64], ['block_merkle_version', U8], ['match_batch_seq', U64], ['match_count', U32],
    ['batch_crc32', 8], ['total_chunks', U32], ['chunk_index', U32], ['archive_b64', TEXT],
    ['validator_signatures', TEXT], ['publisher', 64], ['publisher_attestations', TEXT],
    ['status_id', U64], ['block_index_doge', U64], ['action_index', U64]
];
const INT_COLS = new Set(['section_index', 'version', 'block_index', 'checkpoint_seq', 'snapshot_block',
    'state_root_version', 'block_merkle_version', 'match_batch_seq', 'match_count', 'total_chunks',
    'chunk_index', 'status_id', 'block_index_doge', 'action_index']);
function assertSqlSafe(args) {
    assert.strictEqual(args.length, SHAPE.length, 'one bound value per column');
    args.forEach((v, i) => {
        const [col, max] = SHAPE[i];
        if(v === null) return;
        if(INT_COLS.has(col)){
            assert.strictEqual(typeof v, 'number', col + ' binds a number, got ' + typeof v);
            assert.ok(Number.isSafeInteger(v) && v >= 0 && v <= max,
                col + ' = ' + v + ' does not fit its integer column (max ' + max + ')');
        } else {
            assert.strictEqual(typeof v, 'string', col + ' binds a string, got ' + typeof v);
            assert.ok(v.length <= max, col + ' is ' + v.length + ' chars, column holds ' + max);
        }
    });
}

describe('ANCHOR retired wires on a from-genesis replay @regression', function () {
    let indexer, handler;

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'testnet' });
        const db = indexer.indexerDb;
        db.getValidatorsByCapability  = sinon.stub().resolves([{ pubkey: PUBKEY, amount: '1' }]);
        db.hasCapability              = sinon.stub().resolves(true);
        db.getMaxAnchorCheckpointSeq  = sinon.stub().resolves(null);
        db.getArchiveReplayWatermarks = sinon.stub().resolves({ batchSeq: null, checkpointSeq: null });
        db.createAnchorAction         = sinon.stub().resolves();
        db.getAnchorV1ByBatchSeq      = sinon.stub().resolves(null);
        db.getAnchorChunks            = sinon.stub().resolves([]);
        db.setAnchorArchiveStatus     = sinon.stub().resolves();
        db.createValidatorReward      = sinon.stub().resolves();
        handler = new Anchor(indexer);
    });
    afterEach(() => sinon.restore());

    it('a v5 anchor below ANCHOR_ACTIVATION is recorded invalid with SQL-safe bound values', async function () {
        const below = aact.ANCHOR_ACTIVATION.testnet - 1;
        assert.ok(below > 0, 'testnet activation is pinned above genesis');
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 5, COIN: 'DOGE', BLOCK_INDEX: below, ACTION_INDEX: 12 });
        await handler.parse(v5Params(), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: ANCHOR before activation');
        assert.ok(indexer.indexerDb.createAnchorAction.calledOnce, 'the rejected wire is recorded, not dropped');

        // The exact object the parser handed the writer, through the real writer.
        const written = indexer.indexerDb.createAnchorAction.lastCall.args[0];
        const args = await runCreate(makeDb(), written);
        assertSqlSafe(args);
        // Identity survives: version byte, status and the DOGE mined height.
        assert.strictEqual(args[1], 5, 'the retired version byte is kept on the row');
        assert.strictEqual(args[args.length - 2], below, 'block_index_doge is the mined height');
    });

    it('a v7 bundle below ANCHOR_ACTIVATION (three sections walked as one head) is recorded SQL-safe too', async function () {
        const below = aact.ANCHOR_ACTIVATION.testnet - 1;
        // The old bundle: VERSION|NETWORK|SNAPSHOT_BLOCK|SECTION_COUNT|<sections...>|PUBLISHER|...
        const section = (chain) => [chain, '150208', HASH('0'), HASH('1'), HASH('2'), HASH('3'), '150208', '150208',
                                    HASH('d'), '2', HASH('e'), '1', '1', PUBKEY, SIG];
        const params = ['7', 'testnet', '150208', '3', ...section('BTC'), ...section('DOGE'), ...section('LTC'),
                        PUBKEY, '1', PUBKEY, SIG];
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE', BLOCK_INDEX: below, ACTION_INDEX: 22 });
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'invalid: ANCHOR before activation');
        const written = indexer.indexerDb.createAnchorAction.lastCall.args[0];
        assertSqlSafe(await runCreate(makeDb(), written));
    });

    it('a hostile v1 at/above activation with junk in bounded fields is recorded SQL-safe, so one bad ANCHOR cannot park the indexer', async function () {
        const at = aact.ANCHOR_ACTIVATION.testnet;
        // v1 layout with a 64-char "crc", a hash where MATCH_COUNT goes, a 130-char publisher.
        const params = ['1', 'BTC', 'testnet', '500', HASH('0'), HASH('1'), HASH('2'), HASH('3'),
                        '0', '100', '0', HASH('9'), HASH('c'), '1', 'AAAA', '1', PUBKEY, SIG,
                        'z'.repeat(130), '1', PUBKEY, SIG];
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', BLOCK_INDEX: at, ACTION_INDEX: 900 });
        await handler.parse(params, data, null);
        assert.match(String(data['STATUS']), /^invalid: /, 'the malformed head is rejected: ' + data['STATUS']);
        assert.ok(indexer.indexerDb.createAnchorAction.calledOnce, 'the rejected wire is recorded, not dropped');
        const written = indexer.indexerDb.createAnchorAction.lastCall.args[0];
        const args = await runCreate(makeDb(), written);
        assertSqlSafe(args);
        assert.strictEqual(args[17], null, 'a 64-char crc does not fit VARCHAR(8): NULL, never truncated');
        assert.strictEqual(args[22], null, 'a 130-char publisher does not fit VARCHAR(64)');
    });

    it('the writer maps every non-numeric numeric-slot value to NULL and keeps real numbers', async function () {
        const args = await runCreate(makeDb(), {
            ACTION_INDEX: 12, FORMAT: 5, STATUS: 'invalid: ANCHOR before activation', BLOCK_INDEX: 67856088,
            CHAIN: 'DOGE', NETWORK: 'testnet',
            BLOCK_INDEX_CHECKPOINTED: '67856002', CHECKPOINT_SEQ: HASH('9'), SNAPSHOT_BLOCK: 'testnet',
            STATE_ROOT_VERSION: '', BLOCK_MERKLE_VERSION: 'x', MATCH_BATCH_SEQ: HASH('a'),
            MATCH_COUNT: 'Infinity', TOTAL_CHUNKS: '1', CHUNK_INDEX: undefined
        });
        assertSqlSafe(args);
        // Column order: section_index, version, chain, network, block_index, block_hash, ledger_hash,
        // actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version,
        // block_merkle_root, block_merkle_version, match_batch_seq, match_count, batch_crc32,
        // total_chunks, chunk_index, ...
        assert.strictEqual(args[4], 67856002, 'a numeric string still coerces');
        assert.strictEqual(args[9], null, 'a hash in checkpoint_seq is NULL, not NaN');
        assert.strictEqual(args[10], null, 'a chain name in snapshot_block is NULL');
        assert.strictEqual(args[14], null, 'junk block_merkle_version is NULL');
        assert.strictEqual(args[15], null, 'a hash in match_batch_seq is NULL');
        assert.strictEqual(args[16], null, 'Infinity is not a storable count');
        assert.strictEqual(args[18], 1);
        assert.strictEqual(args[19], null, 'absent stays NULL');
    });
});
