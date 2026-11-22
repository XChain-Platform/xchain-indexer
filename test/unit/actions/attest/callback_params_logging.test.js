// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The stored callback params are read by one shared reader on the ATTEST response,
// ATTEST expiry and XCALL callback paths: a corrupt or non-list column reads as no
// params on every node, and each path says so in the log.

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const observability = require('../../../../src/observability/index.js');
const { callbackParamsOf } = require('../../../../src/actions/callback_params.js');
const { setUpAttestHandler, makeRequestRow } = require('../../../helpers/attest_fixture.js');
const xf = require('../xcall.test/helpers/xcall_fixtures.js');

describe('callbackParamsOf @regression', function () {
    let warn;
    beforeEach(() => { warn = sinon.stub(observability.getLogger(), 'warn'); });
    afterEach(() => sinon.restore());

    it('returns a stored array untouched and stays silent', function () {
        assert.deepStrictEqual(callbackParamsOf({ callback_params_json: '["a",2]' }, 'x'), ['a', 2]);
        assert.strictEqual(warn.callCount, 0);
    });

    it('reads a missing column as no params without a warning', function () {
        assert.deepStrictEqual(callbackParamsOf({ callback_params_json: null }, 'x'), []);
        assert.strictEqual(warn.callCount, 0);
    });

    it('reads unparseable JSON as no params and warns with the label and request id', function () {
        assert.deepStrictEqual(callbackParamsOf({ request_id: 'ab'.repeat(32), callback_params_json: '<<<' }, 'where'), []);
        assert.strictEqual(warn.callCount, 1);
        assert.match(warn.firstCall.args[0], /^where: malformed callback_params_json for request abababababababab\.\.\./);
    });

    it('reads valid JSON that is not an array as no params and warns', function () {
        assert.deepStrictEqual(callbackParamsOf({ call_id: 'cd'.repeat(32), callback_params_json: '{"a":1}' }, 'where'), []);
        assert.strictEqual(warn.callCount, 1);
        assert.match(warn.firstCall.args[0], /^where: callback_params_json for request cdcdcdcdcdcdcdcd\.\.\. is not a JSON array/);
    });
});

describe('callback paths report a corrupt callback_params_json @regression', function () {
    let warn;
    beforeEach(() => { warn = sinon.stub(observability.getLogger(), 'warn'); });
    afterEach(() => sinon.restore());

    const warned = (pattern) => warn.getCalls().some(c => pattern.test(String(c.args[0])));

    it('warns on the ATTEST expiry path and still injects empty params', async function () {
        const s = setUpAttestHandler();
        await s.handler.injectExpiredCallback(makeRequestRow({ callback_params_json: '<<<bad>>>' }),
            { BLOCK_INDEX: 200, BLOCK_TIME: 1700000100, ACTION_INDEX: 9 });
        assert.ok(warned(/^injectExpiredCallback: malformed callback_params_json/));
        const params = s.executeStub.parse.firstCall.args[0];
        assert.deepStrictEqual(params.slice(-2), ['expired', '']);
    });

    it('warns on the ATTEST relayed-response path', async function () {
        const s = setUpAttestHandler();
        await s.handler.injectCallbackExecute(makeRequestRow({ callback_params_json: '"text"' }), {
            BLOCK_INDEX: 200, BLOCK_TIME: 1700000100, ACTION_INDEX: 9, TX_HASH: 'e'.repeat(64),
            TX_INDEX: 1, TX_VOUT: 0, RESPONSE_STATUS: 'ok', RESPONSE_PAYLOAD: 'p',
        });
        assert.ok(warned(/^_injectCallbackExecute: callback_params_json .* is not a JSON array/));
    });

    it('warns on the XCALL callback path and injects only the fixed outcome tuple', async function () {
        const s = xf.freshXcall();
        s.handler.config['GAS_SCHEDULE'] = Object.assign({}, s.handler.config['GAS_SCHEDULE'] || {}, { VM_XCALL_CALLBACK: 100000 });
        const row = xf.makeRequestRow({ callback_params_json: '<<<bad>>>' });
        await s.handler.injectCallback(row, Object.assign(xf.ctx(), { ACTION_INDEX: 9 }), 'ok', 'r');
        assert.ok(warned(/^XCALL callback: malformed callback_params_json/));
        assert.strictEqual(s.executeStub.parse.firstCall.args[0].length, 3 + 4);
    });
});
