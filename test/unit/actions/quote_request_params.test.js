// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const { normalizeQuoteRequest, batchRequestWire } =
    require('../../../src/actions/actions_class/quote_answers.js');
const { buildFeesRpc } = require('../../../src/api/rpc/fees.js');

function makeRpc(){
    let actions = {
        computeFeeQuote: async request => request,
        computePreflight: async request => request,
        computeFeeQuoteDryRun: async request => request
    };
    return buildFeesRpc({ indexer: { indexerDb: {}, actions }, ENABLE_DRYRUN: true });
}

describe('quote request params preserve wire fields @regression @tier1', function () {
    it('normalizes null fields like Array.join while preserving primitive coercion', function () {
        assert.deepStrictEqual(normalizeQuoteRequest({}, 'issue', ['0', null, 'x']).params,
            ['0', '', 'x']);
        assert.deepStrictEqual(normalizeQuoteRequest({}, 'issue', ['0', undefined, 'x']).params,
            ['0', '', 'x']);
        assert.deepStrictEqual(normalizeQuoteRequest({}, 'issue', '0| x |y').params,
            ['0', 'x', 'y']);
        assert.deepStrictEqual(normalizeQuoteRequest({}, 'issue', [0, true]).params,
            ['0', 'true']);
    });

    it('builds a literal BATCH wire with empty null fields', function () {
        assert.strictEqual(batchRequestWire('BATCH', 'BATCH', ['1', null, 'SEND']),
            'BATCH|1||SEND');
        assert.strictEqual(batchRequestWire('SEND', 'SEND', ['1', null]), null);
    });

    it('refuses object params at every RPC boundary', async function () {
        let rpc = makeRpc();
        for(let method of ['feequote', 'preflight', 'feequotedryrun']){
            let objectResult = await rpc[method]({ action: 'SEND', params: ['0', { bad: true }] });
            let nestedResult = await rpc[method]({ action: 'SEND', params: ['0', ['nested']] });
            assert.match(objectResult.error, /params must be a pipe-delimited string/);
            assert.match(nestedResult.error, /params must be a pipe-delimited string/);
        }
    });

    it('allows wire primitives and null fields through every RPC boundary', async function () {
        let rpc = makeRpc();
        for(let method of ['feequote', 'preflight', 'feequotedryrun']){
            let arrayResult = await rpc[method]({ action: 'SEND', params: ['0', null, true, 2] });
            let stringResult = await rpc[method]({ action: 'SEND', params: '0||true|2' });
            let omittedResult = await rpc[method]({ action: 'SEND' });
            assert.deepStrictEqual(arrayResult.params, ['0', null, true, 2]);
            assert.strictEqual(stringResult.params, '0||true|2');
            assert.strictEqual(omittedResult.params, undefined);
        }
    });
});
