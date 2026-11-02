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
 **********************************************************************
 *
 * test/unit/db/text_width/valid_width_reject.test.js
 *
 * A valid action could carry wire text its column cannot hold (LIST TYPE '01', MESSAGE
 * ENCRYPTION_METHOD '01', ISSUE DECIMALS '001', PRICE v1 VALUE of 251 digits, BET FEE
 * '000000000005', a SLASH EQUIV key of 251 characters), and the write halted the block on
 * every indexer. Each handler now refuses exactly those actions, and a value that storage
 * would have stored as NULL anyway keeps the verdict it had.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../../../fixtures/mocks');
const List    = require('../../../../src/actions/list.js');
const Message = require('../../../../src/actions/message.js');
const Bet     = require('../../../../src/actions/bet/index.js');
const Slash   = require('../../../../src/actions/slash/index.js');
const tokenState          = require('../../../../src/actions/issue/token_state.js');
const { validatePriceV1 } = require('../../../../src/actions/price/v1.js');
const { buildIssue }      = require('../../actions/token/issue.test/helpers/fixture.js');
const { EMOJI }           = require('./helpers/strict_db.js');

// [format, field, wire value, verdict, value left for the row]
const LIST_CASES = [
    [0, 'TYPE', '01',  'invalid: TYPE (length)', null],
    [0, 'TYPE', '1.0', 'invalid: TYPE (length)', null],
    [0, 'TYPE', '12',  'invalid: TYPE (unknown)', null],
    [0, 'TYPE', 'ab',  'invalid: TYPE (unknown)', 'ab'],
    [0, 'TYPE', '2',   null, '2'],
    [1, 'EDIT', '01',  'invalid: EDIT (length)', null],
    [1, 'EDIT', '12',  'invalid: EDIT (unknown)', null]
];

// [incoming error, ENCRYPTION_METHOD, verdict, value left for the row]
const MESSAGE_CASES = [
    [null, '01', 'invalid: ENCRYPTION_METHOD (length)', null],
    [null, '1',  null, '1'],
    [null, 'ab', 'invalid: ENCRYPTION_METHOD (format)', 'ab'],
    ['invalid: COIN (value)', '12', 'invalid: COIN (value)', null]
];

// [wire snapshot, verdict]: a value storage normalization stores as NULL keeps its verdict
const ISSUE_CASES = [
    [{ DECIMALS: '001' }, 'invalid: DECIMALS (length)'],
    [{ DECIMALS: '18' }, null],
    [{ DECIMALS: 'abc' }, null],
    [{ MINT_START_BLOCK: '0'.repeat(15) + '1' }, 'invalid: MINT_START_BLOCK (length)'],
    [{ MINT_STOP_BLOCK: '9'.repeat(16) }, 'invalid: MINT_STOP_BLOCK (length)'],
    [{ CALLBACK_BLOCK: '9'.repeat(25) }, null],
    [{ LOCK_BRIDGE: '01' }, 'invalid: LOCK_BRIDGE (length)'],
    [{ LOCK_BRIDGE: '1' }, null],
    [{ BRIDGE_CHAINS: 'LTC,'.repeat(62) + 'LTC' }, 'invalid: BRIDGE_CHAINS (length)'],
    [{ BRIDGE_CHAINS: 'LTC,DOGE' }, null]
];

// [EQUIV key, incoming error, verdict]: checked last, so a refused proof keeps its verdict
const EQUIV_CASES = [
    ['CKPT|' + 'r'.repeat(240) + '|0', null, null],
    ['CKPT|' + 'r'.repeat(246) + '|0', null, 'invalid: EQUIV_KEY (length)'],
    ['CKPT|' + EMOJI + '|0', null, 'invalid: EQUIV_KEY (format)'],
    ['CKPT|' + 'r'.repeat(300) + '|0', 'invalid: SIG_A (does not verify)', 'invalid: SIG_A (does not verify)']
];

function actionsCtx(){
    const indexer = createMockIndexer();
    return { config: indexer.config, util: indexer.util, indexerDb: indexer.indexerDb,
             decoderDb: indexer.decoderDb, mapper: indexer.mapper };
}

async function listVerdict([format, field, value, verdict, stored]){
    const handler = new List(actionsCtx());
    const data = { BLOCK_INDEX: 1, [field]: value };
    handler.indexerDb.getListStoredType = sinon.stub().resolves(1);
    const result = await handler.validateAndLoadList(data, format, null);
    assert.strictEqual(result.error, verdict);
    assert.strictEqual(data[field], stored);
}

function messageVerdict([incoming, method, verdict, stored]){
    const handler = new Message(actionsCtx());
    const data = { ENCRYPTION_METHOD: method };
    assert.strictEqual(handler.validateMessageFormats(data, incoming), verdict);
    assert.strictEqual(data['ENCRYPTION_METHOD'], stored);
}

function issueVerdict([issue, verdict]){
    const { handler } = buildIssue();
    const ctx = { data: Object.assign({}, issue), issue: Object.assign({}, issue),
                  tokenInfo: null, cbInfo: false, error: null };
    tokenState.validateFieldFormats.call(handler, ctx);
    assert.strictEqual(ctx.error, verdict);
}

function priceV1(value, fee){
    const ctx = actionsCtx();
    const config = Object.assign({}, ctx.config, { NETWORK: 'mainnet' });
    const params = ['1', config.COINS[0], 'GOLD', Object.keys(config.FIATS)[0], value, fee, ''];
    return validatePriceV1(config, ctx.util, params, { BLOCK_TIME: 1 }, null);
}

afterEach(function () {
    sinon.restore();
});

describe('Column width rejects on valid actions (handlers) @regression', function () {
    for(const c of LIST_CASES)
        it('LIST format ' + c[0] + ' ' + c[1] + "='" + c[2] + "' gives " + c[3], () => listVerdict(c));

    for(const c of MESSAGE_CASES)
        it("MESSAGE ENCRYPTION_METHOD='" + c[1] + "' after " + c[0] + ' gives ' + c[2], () => messageVerdict(c));

    for(const c of ISSUE_CASES)
        it('ISSUE ' + JSON.stringify(c[0]).substring(0, 60) + ' gives ' + c[1], () => issueVerdict(c));

    it('PRICE v1 refuses a VALUE or FEE longer than its column where the legacy patterns apply', function () {
        assert.strictEqual(priceV1('0'.repeat(249) + '1', ''), null);
        assert.strictEqual(priceV1('0'.repeat(250) + '1', ''), 'invalid: VALUE (length)');
        assert.strictEqual(priceV1('1', '0'.repeat(249) + '1'), null);
        assert.strictEqual(priceV1('1', '0'.repeat(250) + '1'), 'invalid: FEE (length)');
    });

    it("BET feed FEE='000000000005' is refused by width and FEE='5' passes the FEE rules", function () {
        const handler = new Bet(actionsCtx());
        assert.strictEqual(handler.validateFeedTerms({ FEE: '000000000005', BLOCK_TIME: 1 }, null, null),
            'invalid: FEE (length)');
        assert.notStrictEqual(handler.validateFeedTerms({ FEE: '5', BLOCK_TIME: 1 }, null, null),
            'invalid: FEE (length)');
    });

    for(const [key, incoming, verdict] of EQUIV_CASES){
        it('SLASH EQUIV_KEY of ' + [...key].length + ' code points after ' + incoming + ' gives ' + verdict,
            () => assert.strictEqual(Slash.equivKeyStorableError(key, incoming), verdict));
    }
});
