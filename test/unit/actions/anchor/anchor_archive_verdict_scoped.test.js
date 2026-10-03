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
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const reassembly = require('../../../../src/actions/anchor/reassembly.js');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const { stubActiveAt } = require('../../../helpers/gate_modules.js');

const FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';
const MATCH_COUNT_GATE = 'archive_match_count_activation.ARCHIVE_MATCH_COUNT_ACTIVATION';
const VERDICT_GATE = 'archive_section_verdict_activation.ARCHIVE_SECTION_VERDICT_STATE_HASH_ACTIVATION';

function makeHandler(crc = '87654321', matchCount = 1) {
    return {
        config: { COIN: 'DOGE', NETWORK: 'regtest' },
        indexerDb: {
            getAnchorChunks: sinon.stub().resolves([
                { chunk_index: 1, archive_b64: 'continuation' },
            ]),
            setAnchorArchiveRowStatus: sinon.stub().resolves(),
            setAnchorArchiveStatus: sinon.stub().resolves(),
        },
        archiveCrc: sinon.stub().returns(crc),
        archiveMatchCount: sinon.stub().returns(matchCount),
        archiveAuthorScope: sinon.stub().resolves(null),
    };
}

function armCoinThresholds(keys, threshold) {
    const original = gateRegistry.registry.read.bind(gateRegistry.registry);
    const tables = new Map(keys.map(key => [key, Object.assign({}, gateRegistry.get(key), {
        testnet: 9999999999,
        'BTC:testnet': threshold,
        'LTC:testnet': threshold,
        'DOGE:testnet': threshold,
    })]));
    sinon.stub(gateRegistry.registry, 'read').callsFake(
        key => tables.has(key) ? tables.get(key) : original(key));
}

function headData() {
    return {
        STATUS: 'valid', ACTION_INDEX: '41', CHAIN: 'BTC', NETWORK: 'regtest',
        BLOCK_INDEX: 100, MATCH_BATCH_SEQ: 7, MATCH_COUNT: 1,
        BATCH_CRC32: '12345678', TOTAL_CHUNKS: 2, ARCHIVE_B64: 'head',
        SOURCE: 'publisher',
    };
}

function chunkData() {
    return {
        STATUS: 'valid', MATCH_BATCH_SEQ: 7, TOTAL_CHUNKS: 2, BLOCK_INDEX: 101,
    };
}

function parentRow(version) {
    return {
        action_index: '41', chain: 'BTC', block_index_doge: 100,
        match_batch_seq: 7, match_count: 1, batch_crc32: '12345678',
        total_chunks: 2, archive_b64: 'head', version,
    };
}

const SIDES = {
    head: (handler, version) => reassembly.reassembleAtHead(handler, headData(), null, version),
    chunk: (handler, version) => reassembly.reassembleAtChunk(
        handler, chunkData(), parentRow(version), null, null),
};

function assertStamp(handler, scoped) {
    assert.deepStrictEqual(handler.indexerDb.setAnchorArchiveRowStatus.args,
        scoped ? [[41, 'invalid_archive']] : []);
    assert.deepStrictEqual(handler.indexerDb.setAnchorArchiveStatus.args,
        scoped ? [] : [[41, 'invalid_archive']]);
}

describe('ANCHOR folded archive verdict scope', function () {
    beforeEach(function () {
        stubActiveAt(sinon, VERDICT_GATE, true);
        stubActiveAt(sinon, FOLD_GATE, true);
    });

    afterEach(function () {
        sinon.restore();
    });

    for (const [side, reassemble] of Object.entries(SIDES)) {
        it(side + ' stamps only the archive row for a v3 parent with both gates active', async function () {
            const handler = makeHandler();
            await reassemble(handler, side === 'chunk' ? '3' : 3);
            assertStamp(handler, true);
            assert.ok(gateRegistry.activeAt.calledWith(
                VERDICT_GATE, 'regtest', 'DOGE', 100, null));
            assert.ok(gateRegistry.activeAt.calledWith(
                FOLD_GATE, 'regtest', 'DOGE', 100, null));
        });

        it(side + ' scopes a v3 MATCH_COUNT failure with both gates active', async function () {
            stubActiveAt(sinon, MATCH_COUNT_GATE, true);
            const handler = makeHandler('12345678', 2);
            await reassemble(handler, 3);
            assertStamp(handler, true);
        });

        it(side + ' keeps a v1 parent action-wide with both gates active', async function () {
            const handler = makeHandler();
            await reassemble(handler, 1);
            assertStamp(handler, false);
        });

        it(side + ' keeps a v3 parent action-wide while the verdict gate is inactive', async function () {
            stubActiveAt(sinon, VERDICT_GATE, false);
            const handler = makeHandler();
            await reassemble(handler, 3);
            assertStamp(handler, false);
        });

        it(side + ' keeps a v3 parent action-wide while the fold gate is inactive', async function () {
            stubActiveAt(sinon, FOLD_GATE, false);
            const handler = makeHandler();
            await reassemble(handler, 3);
            assertStamp(handler, false);
        });
    }
});

describe('ANCHOR folded archive verdict post-arm coin thresholds', function () {
    const height = 67961578;

    afterEach(function () { sinon.restore(); });

    it('activates both DOGE testnet gates exactly at the armed height', async function () {
        armCoinThresholds([VERDICT_GATE, FOLD_GATE], height);
        const below = makeHandler();
        below.config.NETWORK = 'testnet';
        const belowData = headData();
        belowData.NETWORK = 'testnet';
        belowData.BLOCK_INDEX = height - 1;
        await reassembly.reassembleAtHead(below, belowData, null, 3);
        assertStamp(below, false);

        const active = makeHandler();
        active.config.NETWORK = 'testnet';
        const activeData = headData();
        activeData.NETWORK = 'testnet';
        activeData.BLOCK_INDEX = height;
        await reassembly.reassembleAtHead(active, activeData, null, 3);
        assertStamp(active, true);
    });
});
