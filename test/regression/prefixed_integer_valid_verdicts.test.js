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
 * test/regression/prefixed_integer_valid_verdicts.test.js
 *
 * A hexadecimal, binary or octal integer field never reaches an integer column on a
 * valid action.
 *
 * isNumeric and isInteger accept '0x10', '0b101' and '0o17' (Number reads each as an
 * integer), the bc helpers read them the same way, and the row writers bind the wire
 * text, which a strict session refuses in an integer column (errno 1265). The block
 * transaction threw and retried forever. An EXPIRATION of '0x7fffffff' on a DISPENSER,
 * ORDER or SWAP, a BET DEADLINE, REFUND_WINDOW or OUTCOME, a LINK action index on another
 * chain, an XCALL TARGET_CONTRACT_INDEX (parseInt reads '0x'), and an ISSUE CALLBACK_BLOCK
 * (bound into tokens.callback_block) all passed every rule. Each such action wrote its row
 * whatever its verdict, except the ISSUE, whose refused row stores the literal in a
 * VARCHAR; so each refusal here needs no activation height, and the ISSUE one runs after
 * every other verdict.
 *
 * Every refused case flips a verdict the unfixed code returned as valid. The controls are
 * spellings the column converts ('1e12', '+100', '00100'), plain integers, a prefixed
 * literal normalization nulls (past the column's range), and a literal reading zero for
 * CALLBACK_BLOCK: each keeps its verdict.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig }   = require('../fixtures/config');
const Utility             = require('../../src/utility');
const orderValidation     = require('../../src/actions/order/validate.js');
const swapValidation      = require('../../src/actions/swap/validate.js');
const dispenserValidation = require('../../src/actions/dispenser/validate_format.js');
const betCreateValidation = require('../../src/actions/bet/create_feed.js');
const betValidation       = require('../../src/actions/bet/validate.js');
const Link                = require('../../src/actions/link.js');
const { parseRequest }    = require('../../src/actions/xcall/request.js');
const issueFixtures       = require('../unit/bridge/issue_bridge_optin.test/helpers/issue_fixtures.js');

const U64_MAX  = '18446744073709551615';
const PREFIXED = ['0x10', '0X10', '0b101', '0o17'];
const DECIMAL  = ['1e12', '+100', '00100', '100'];
const PAST_U64 = '0x10000000000000000';

// One handler shape for the validator parts: real config and Utility, the exact-integer
// wire gate off (it refuses these spellings on its own once armed), and the reads the parts
// make answering as an open, unrestricted market.
function handler(parts = []){
    const util = new Utility();
    sinon.stub(util, 'logError');
    const h = {
        config:    getTestConfig(),
        util,
        actions:   { protocolChanges: { isEnabled: async () => false } },
        indexerDb: { isActionAllowed: async () => true, countOpenBetsByFeed: async () => 0,
                     getContract: async () => ({ action_index: 5 }) },
        listTypes: [2]
    };
    for(const part of parts) Object.assign(h, part);
    return h;
}

afterEach(function(){ sinon.restore(); });

describe('prefixed integer spellings on valid DISPENSER, ORDER and SWAP actions @regression @tier1', function(){

    it('keepsPrefixedSpelling answers true only for a literal normalization keeps', function(){
        const util = new Utility();
        for(const v of PREFIXED.concat(['0xffffffffffffffff', ' 0x10 ']))
            assert.strictEqual(util.keepsPrefixedSpelling(v, U64_MAX), true, v);
        for(const v of DECIMAL.concat([PAST_U64, U64_MAX, '1.5', '', null, undefined, '-0x10', '0x']))
            assert.strictEqual(util.keepsPrefixedSpelling(v, U64_MAX), false, String(v));
        assert.strictEqual(util.keepsPrefixedSpelling('0xffffffff', '4294967295'), true);
        assert.strictEqual(util.keepsPrefixedSpelling('0x100000000', '4294967295'), false);
    });

    it('refuses a prefixed DISPENSER EXPIRATION and keeps every other spelling', async function(){
        const h = handler([dispenserValidation]);
        const verdict = async (expiration, format = 0) => {
            const ctx = { data: { BLOCK_INDEX: 8, EXPIRATION: expiration, GET_AMOUNT: '1', GET_COIN: 'BTC',
                                  GET_ADDRESS: null, FIAT_CODE: null, ORACLE_ADDRESS: null },
                          error: null, format, getTokenInfo: false };
            await h.validateAddressAndExpirationFields(ctx);
            return ctx.error;
        };
        for(const v of PREFIXED.concat(['0x7fffffff'])){
            assert.strictEqual(await verdict(v), 'invalid: EXPIRATION (format)', v);
            assert.strictEqual(await verdict(v, 2), 'invalid: EXPIRATION (format)', v);
        }
        for(const v of DECIMAL)
            assert.strictEqual(await verdict(v), null, v);
        // Past the column's range the existing rule already refused it, with the same verdict.
        assert.strictEqual(await verdict(PAST_U64), 'invalid: EXPIRATION (format)');
    });

    it('refuses a prefixed ORDER or SWAP EXPIRATION on a create and an edit', function(){
        for(const validation of [orderValidation, swapValidation]){
            const h = handler();
            const verdict = (expiration, format) => {
                const st = { format, data: { EXPIRATION: expiration, BLOCK_TIME: 10 }, error: null };
                validation.validateFormats(h, st);
                return st.error;
            };
            for(const v of PREFIXED.concat(['0x7fffffff']))
                assert.strictEqual(verdict(v, 2), 'invalid: EXPIRATION (format)', v);
            for(const v of DECIMAL)
                assert.strictEqual(verdict(v, 2), null, v);
        }
    });

});

describe('prefixed integer spellings on valid BET and LINK actions @regression @tier1', function(){

    it('refuses a prefixed BET DEADLINE or REFUND_WINDOW on a feed create', function(){
        const h = handler([betCreateValidation]);
        const verdict = (deadline, refundWindow) =>
            h.validateFeedTerms({ BLOCK_TIME: 1000, DEADLINE: deadline, REFUND_WINDOW: refundWindow }, { DECIMALS: 0 }, null);
        assert.strictEqual(verdict('0x7d0', '7200'), 'invalid: DEADLINE (format)');
        assert.strictEqual(verdict('0b11111010000', '7200'), 'invalid: DEADLINE (format)');
        assert.strictEqual(verdict('2000', '0x1c20'), 'invalid: REFUND_WINDOW (format)');
        assert.strictEqual(verdict('2000', '0o16040'), 'invalid: REFUND_WINDOW (format)');
        for(const [deadline, refundWindow] of [['2000', '7200'], ['2e3', '+7200'], ['02000', '7.2e3'], ['+2000', '07200']])
            assert.strictEqual(verdict(deadline, refundWindow), null, deadline + ' ' + refundWindow);
    });

    it('refuses a prefixed BET OUTCOME on a bet and a resolve', async function(){
        const h = handler([betValidation]);
        const feed = { ACTION_INDEX: 9, SOURCE: 'oracle', FEED_STATUS: 'open', DEADLINE: '2000',
                       EXPIRE_AT: '9000', OUTCOMES: 'yes,no,maybe', MIN_AMOUNT: null, TICK: 'TEST' };
        const place = (outcome) => h.validatePlaceBet({ BLOCK_TIME: 1000, SOURCE: 'bettor', OUTCOME: outcome, AMOUNT: '1' },
            2, feed, { DECIMALS: 0 }, null);
        const resolve = (outcome) => h.validateResolve({ BLOCK_TIME: 3000, OUTCOME: outcome }, 3, feed, null);
        for(const v of ['0x1', '0X2', '0b1', '0o2']){
            assert.strictEqual(await place(v), 'invalid: OUTCOME (format)', v);
            assert.strictEqual(await resolve(v), 'invalid: OUTCOME (format)', v);
        }
        for(const v of ['1', '+1', '01', '1e0', '2']){
            assert.strictEqual(await place(v), null, v);
            assert.strictEqual(await resolve(v), null, v);
        }
        // Out of the feed's range the range rule still answers first.
        assert.strictEqual(await place('0x5'), 'invalid: OUTCOME (range)');
    });

    it('refuses a prefixed LINK action index on either side', function(){
        const h = handler();
        const verdict = (coin1Index, coin2Index) => Link.prototype.validateCoinsAndFormats.call(h,
            { COIN1: 'LTC', COIN1_ACTION_INDEX: coin1Index, COIN2: 'DOGE', COIN2_ACTION_INDEX: coin2Index }, 0, null);
        assert.strictEqual(verdict('0x10', '5'), 'invalid: COIN1_ACTION_INDEX (format)');
        assert.strictEqual(verdict('5', '0o17'), 'invalid: COIN2_ACTION_INDEX (format)');
        for(const v of DECIMAL)
            assert.strictEqual(verdict(v, v), null, v);
        assert.strictEqual(verdict(PAST_U64, '5'), null);
    });

});

describe('prefixed integer spellings on valid XCALL and ISSUE actions @regression @tier1', function(){

    it('refuses a hexadecimal XCALL TARGET_CONTRACT_INDEX that parseInt reads as a contract', async function(){
        const run = async (target) => {
            const h = handler();
            h.deriveCallId = (data, error) => error;
            h.indexerDb.createCrossChainCallRequest = sinon.stub().resolves();
            h.mapper = { createMappings: sinon.stub().resolves() };
            const data = { IS_EMISSION: true, EMITTER: 5, BLOCK_INDEX: 100, SOURCE: 'caller' };
            const params = ['0', 'a'.repeat(64), 'LTC', target, 'run', '[]', '100000', 'done', '[]', '100', '1'];
            await parseRequest.call(h, params, data, null);
            return data['STATUS'];
        };
        assert.strictEqual(await run('0x10'), 'invalid: TARGET_CONTRACT_INDEX (format)');
        for(const v of ['16', '+16', '016', '1.6e1'])
            assert.strictEqual(await run(v), 'valid', v);
    });

    it('refuses an ISSUE CALLBACK_BLOCK the tokens row cannot store, after every other verdict', async function(){
        const issue = (callbackBlock) => issueFixtures.run({
            params: ['4', 'FUFU', callbackBlock, '', '', ''],
            token:  issueFixtures.tokenRow()
        });
        for(const v of ['0x7fffffff', '0b1111111111', '0o7777'])
            assert.strictEqual((await issue(v)).status, 'invalid: CALLBACK_BLOCK (format)', v);
        for(const v of ['1000', '+1000', '01000', '1e3'])
            assert.strictEqual((await issue(v)).status, 'valid', v);
        // A refused ISSUE keeps its own verdict: its issues row stores the literal as text.
        assert.strictEqual((await issue('0x10')).status, 'invalid: CALLBACK_BLOCK (block index)');
    });
});
