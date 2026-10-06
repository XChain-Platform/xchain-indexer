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

const reassembly = require('../../../../../src/actions/anchor/reassembly.js');
const { stubActiveAt } = require('../../../../helpers/gate_modules.js');

const HEAD_GATE_KEY = 'archive_head_unverified_gate_activation.ARCHIVE_HEAD_UNVERIFIED_GATE_ACTIVATION';
const MATCH_COUNT_KEY = 'archive_match_count_activation.ARCHIVE_MATCH_COUNT_ACTIVATION';
const SIGNED_CRC = '12345678';

function makeHandler(crc) {
    const stamp = sinon.stub().resolves();
    return {
        stamp,
        handler: {
            config: { NETWORK: 'regtest' },
            indexerDb: {
                getAnchorChunks: sinon.stub().resolves([
                    { chunk_index: 1, archive_b64: 'continuation' },
                ]),
                setAnchorArchiveStatus: stamp,
            },
            archiveCrc: sinon.stub().returns(crc),
            archiveMatchCount: sinon.stub().throws(new Error('MATCH_COUNT gate must stay inactive')),
            archiveAuthorScope: sinon.stub().resolves(null),
        },
    };
}

function headData() {
    return {
        STATUS: 'valid', ACTION_INDEX: '41', CHAIN: 'BTC', NETWORK: 'regtest',
        BLOCK_INDEX: 100, MATCH_BATCH_SEQ: 7, MATCH_COUNT: 1,
        BATCH_CRC32: SIGNED_CRC, TOTAL_CHUNKS: 2, ARCHIVE_B64: 'head',
        SOURCE: 'publisher',
    };
}

function chunkData() {
    return {
        STATUS: 'valid', MATCH_BATCH_SEQ: 7, TOTAL_CHUNKS: 2, BLOCK_INDEX: 101,
    };
}

function parentRow() {
    return {
        action_index: '41', chain: 'BTC', block_index_doge: 100,
        match_batch_seq: 7, match_count: 1, batch_crc32: SIGNED_CRC,
        total_chunks: 2, archive_b64: 'head',
    };
}

const SIDES = {
    head: async handler => reassembly.reassembleAtHead(handler, headData(), null, 1),
    chunk: async handler => reassembly.reassembleAtChunk(
        handler, chunkData(), parentRow(), null, null),
};

describe('ANCHOR pre-fold archive verdict', function () {
    beforeEach(function () {
        stubActiveAt(sinon, HEAD_GATE_KEY, false);
        stubActiveAt(sinon, MATCH_COUNT_KEY, false);
    });

    afterEach(function () {
        sinon.restore();
    });

    for (const [side, reassemble] of Object.entries(SIDES)) {
        it(side + ' stamps the action-wide verdict once on a CRC mismatch', async function () {
            const { handler, stamp } = makeHandler('87654321');
            await reassemble(handler);
            assert.deepStrictEqual(stamp.args, [[41, 'invalid_archive']]);
        });

        it(side + ' leaves the verdict unchanged on a CRC match below MATCH_COUNT', async function () {
            const { handler, stamp } = makeHandler(SIGNED_CRC);
            await reassemble(handler);
            assert.strictEqual(stamp.called, false);
            assert.strictEqual(handler.archiveMatchCount.called, false);
        });
    }
});
