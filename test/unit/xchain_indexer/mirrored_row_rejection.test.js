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
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const sinon = require('sinon');
const blockParse = require('../../../src/XChainIndexer/block_parse.js');
const blockCommit = require('../../../src/XChainIndexer/block_commit.js');
const mirrorApply = require('../../../src/actions/attest/mirror_apply.js');

const BAD_ID = 'a'.repeat(64);
const GOOD_ID = 'b'.repeat(64);
const GOOD_BODY = 'accepted';
const GOOD_SIGS = JSON.stringify([{ pubkey: 'c'.repeat(64), sig: 'd'.repeat(128) }]);

function row(requestId, signatures, body) {
    return {
        request_id: requestId,
        provider_id: 'http_get',
        status: 'ok',
        signatures,
        response_payload: body,
        response_hash: crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')
    };
}

const ROWS = [
    row(BAD_ID, '{not json', 'malformed'),
    row(GOOD_ID, GOOD_SIGS, GOOD_BODY)
];

function follower() {
    const node = Object.assign({
        config: { BLOCK_CHECK_INTERVAL: 1 },
        util: { logError: sinon.stub(), withTimeout: (promise) => promise },
        indexerDb: {
            beginTransaction: sinon.stub().resolves(),
            commitTransaction: sinon.stub().resolves(),
            rollbackTransaction: sinon.stub().resolves(),
            currentTxEpoch: () => 1,
            runInTxEpoch: (epoch, fn) => fn()
        },
        applied: [],
        rejected: [],
        openBlockTransaction: async () => false,
        blockWatchdogTimeout: () => 1000,
        afterBlockCommit: async (blk, counts, last) => last + 1
    }, blockParse, { abandonBlock: blockCommit.abandonBlock });

    const handler = Object.assign({}, mirrorApply, {
        isMirrorEraRequest: () => true,
        verifyMirroredResponse: sinon.stub().resolves({ error: null }),
        stampMirroredResponse: async (data, mirrorRow) => {
            data['STATUS'] = 'valid';
            node.applied.push(mirrorRow.request_id);
        },
        settleMirroredResponse: sinon.stub().resolves(),
        mapper: { createMappings: sinon.stub().resolves() }
    });

    node.runBlockPasses = async (blk) => {
        for(const mirrorRow of ROWS){
            const verdict = await handler.applyMirroredResponse({
                BLOCK_INDEX: blk.blockToParse,
                MIRROR_RESPONSE: mirrorRow,
                MIRROR_REQUEST: { request_status: 'pending', provider_id: 'http_get' }
            });
            if(verdict && verdict.rejected) node.rejected.push(verdict);
        }
        return [0, 0, 0];
    };
    return node;
}

describe('malformed mirrored row rejection @regression @tier1', function () {

    beforeEach(function () { sinon.stub(console, 'info'); });
    afterEach(function () { sinon.restore(); });

    it('has two followers reject the same malformed row identically while the block loop continues', async function () {
        const one = follower();
        const two = follower();
        const a = await one.processBlock({ blockToParse: 700 }, 699, 699);
        const b = await two.processBlock({ blockToParse: 700 }, 699, 699);
        const rejection = {
            rejected: true,
            source: 'attestation_responses',
            row: BAD_ID,
            code: 'signatures column is not a non-empty JSON array'
        };

        assert.deepStrictEqual(a, { committed: true, stop: false, lastDecoderBlock: 700 });
        assert.deepStrictEqual(a, b);
        assert.deepStrictEqual(one.rejected, [rejection]);
        assert.deepStrictEqual(one.rejected, two.rejected);
        assert.deepStrictEqual(one.applied, [GOOD_ID]);
        assert.deepStrictEqual(one.applied, two.applied);
        assert.strictEqual(one.indexerDb.rollbackTransaction.callCount, 0);
        assert.strictEqual(one.indexerDb.commitTransaction.callCount, 1);
        assert.strictEqual(one.util.logError.callCount, 0);
    });
});
