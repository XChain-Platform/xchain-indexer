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
 * test/regression/prefixed_mint_window_verdicts.test.js
 *
 * A hexadecimal, binary or octal MINT_START_BLOCK or MINT_STOP_BLOCK never reaches the
 * tokens row of a valid ISSUE.
 *
 * isValidAmountFormat accepts '0x7fffffff', '0b1111111111' and '0o7777' wherever the
 * amount-representability rule is unarmed (mainnet, and testnet blocks before its
 * threshold), the mint-window rules read them as numbers, and the tokens writer binds the
 * wire text into a BIGINT UNSIGNED column, which a strict session refuses (errno 1265). The
 * block transaction threw and retried forever, so no such ISSUE is in any history and the
 * refusal needs no activation height. A refused ISSUE stores these fields only in VARCHAR
 * issues columns, so the refusal runs after every other verdict.
 *
 * Controls: decimal spellings the column converts ('1e3', '+1000', '01000'), a prefixed
 * literal past the column's range (normalization nulls it and the row stores 0), an ISSUE
 * refused earlier for another reason, and the armed testnet path, where the
 * representability rule already answers with the same text.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');
const Issue          = require('../../src/actions/issue/index.js');
const normalize      = require('../../src/db/database/normalize.js');
const tokenWriter    = require('../../src/db/tokens/token_writer.js');
const issueFixtures  = require('../unit/bridge/issue_bridge_optin.test/helpers/issue_fixtures.js');

const U64_MAX       = '18446744073709551615';
const PREFIXED      = ['0x7fffffff', '0X7FFFFFFF', '0b1111111111', '0o7777', '0x0'];
const DECIMAL       = ['1000', '1e3', '+1000', '01000'];
const PAST_U64      = '0x10000000000000000';
const MAINNET_TIME  = 1700000000;
// The BTC testnet representability threshold: the rule binds at and above it.
const TESTNET_ARMED = 1791061097;
// Where MINT_START_BLOCK and MINT_STOP_BLOCK sit in the tokens INSERT arguments.
const START_ARG = 17;
const STOP_ARG  = 18;

afterEach(function(){ sinon.restore(); });

// Drive one ISSUE on `network`. The fixture's runner sets only the handler's config, while
// isValidAmountFormat reads the Utility's own, so both are set here.
async function runIssue({ params, network = 'mainnet', blockTime = MAINNET_TIME, token = issueFixtures.tokenRow() }){
    const indexer = createMockIndexer();
    for(const cfg of [indexer.config, indexer.util.config]){
        cfg.COIN    = 'BTC';
        cfg.NETWORK = network;
    }
    indexer.indexerDb.getTokenInfo.resolves(token);
    indexer.indexerDb.getTokenControllers.resolves(new Map());
    indexer.indexerDb.isValidList.resolves(true);
    const handler = new Issue(issueFixtures.makeActionsCtx(indexer));
    const data = createBaseData({ ACTION: 'ISSUE', FORMAT: Number(params[0]), BLOCK_INDEX: 500,
                                  BLOCK_TIME: blockTime, SOURCE: issueFixtures.OWNER });
    await handler.parse(params, data, null);
    return { status: data.STATUS, indexer };
}

// ISSUE format 2: VERSION|TICK|MAX_MINT|MINT_SUPPLY|TRANSFER_SUPPLY|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|MEMO
function format2(start, stop){
    return ['2', 'FUFU', '', '', '', '', start, stop, ''];
}

// ISSUE format 0, the full issuance, from the fields named in `fields`; every other is empty.
const FORMAT0 = ('VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|' +
    'LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|' +
    'CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|LOCK_MINT|' +
    'LOCK_MINT_SUPPLY|MEMO').split('|');
function format0(fields){
    return FORMAT0.map(name => (name === 'VERSION') ? '0' : (fields[name] || ''));
}

// The MINT_START_BLOCK and MINT_STOP_BLOCK the real tokens writer binds for the data a valid
// ISSUE hands createToken.
async function boundMintWindow(indexer){
    const data = indexer.indexerDb.createToken.firstCall.args[0];
    let insertArgs = null;
    const db = Object.assign({}, normalize, tokenWriter, {
        util:          indexer.util,
        config:        indexer.config,
        createTicker:  async () => 1,
        createAddress: async () => 1,
        doQuery:       async (sql, args) => { if(/INSERT/i.test(sql)) insertArgs = args; return []; }
    });
    await db.createToken(data);
    return [insertArgs[START_ARG], insertArgs[STOP_ARG]];
}

// Whether a strict session stores the bound value in a BIGINT UNSIGNED column as it is.
function stores(util, value){
    return value === 0 || util.storesInIntegerColumn(value, '0', U64_MAX);
}

describe('prefixed MINT_START_BLOCK and MINT_STOP_BLOCK on a valid mainnet ISSUE @regression @tier1', function(){

    it('refuses a prefixed MINT_START_BLOCK or MINT_STOP_BLOCK the tokens row would bind', async function(){
        for(const v of PREFIXED){
            const start = await runIssue({ params: format2(v, '') });
            assert.strictEqual(start.status, 'invalid: MINT_START_BLOCK (format)', v);
            assert.strictEqual(start.indexer.indexerDb.createToken.called, false, v);
            const stop = await runIssue({ params: format2('', v) });
            assert.strictEqual(stop.status, 'invalid: MINT_STOP_BLOCK (format)', v);
            assert.strictEqual(stop.indexer.indexerDb.createToken.called, false, v);
            const reissue = await runIssue({ params: format0({ TICK: 'FUFU', MINT_STOP_BLOCK: v }) });
            assert.strictEqual(reissue.status, 'invalid: MINT_STOP_BLOCK (format)', v);
        }
    });

    it('keeps decimal spellings and a literal past the range valid, each bound as a storable integer', async function(){
        for(const v of DECIMAL.concat([PAST_U64])){
            for(const params of [format2(v, ''), format2('', v)]){
                const { status, indexer } = await runIssue({ params });
                assert.strictEqual(status, 'valid', v);
                const [start, stop] = await boundMintWindow(indexer);
                assert.ok(stores(indexer.util, start), v + ' start ' + start);
                assert.ok(stores(indexer.util, stop), v + ' stop ' + stop);
            }
        }
    });

    it('keeps the verdict of an ISSUE refused for another reason', async function(){
        // '0x10' reads 16, behind block 500: the mint-window rule answers first.
        assert.strictEqual((await runIssue({ params: format2('0x10', '') })).status, 'invalid: MINT_START_BLOCK < BLOCK_INDEX');
        assert.strictEqual((await runIssue({ params: format2('', '0b1') })).status, 'invalid: MINT_STOP_BLOCK < BLOCK_INDEX');
        assert.strictEqual((await runIssue({ params: format2('2000', '0x3e8') })).status, 'invalid: MINT_STOP_BLOCK < MINT_START_BLOCK');
        // Another owner's token is refused before any field rule, and its issues row keeps the literal.
        const stranger = await runIssue({ params: format2('0x7fffffff', '0o7777'),
                                          token: issueFixtures.tokenRow({ OWNER: issueFixtures.STRANGER }) });
        assert.strictEqual(stranger.status, 'invalid: issued by another address');
        const row = stranger.indexer.indexerDb.createIssue.firstCall.args[0];
        assert.strictEqual(row.MINT_START_BLOCK, '0x7fffffff');
        assert.strictEqual(row.MINT_STOP_BLOCK, '0o7777');
        // A new token whose issuance fee the source cannot pay keeps the fee verdict.
        const unpaid = await runIssue({ params: format0({ TICK: 'NEWTOKEN', MAX_SUPPLY: '1000', DECIMALS: '0',
                                                          MINT_START_BLOCK: '0x7fffffff' }), token: null });
        assert.strictEqual(unpaid.status, 'invalid: insufficient funds (FEE)');
        // The CALLBACK_BLOCK refusal answers first when both fields carry a literal.
        const both = await runIssue({ params: format0({ TICK: 'FUFU', CALLBACK_BLOCK: '0x7fffffff',
                                                        MINT_START_BLOCK: '0x7fffffff' }) });
        assert.strictEqual(both.status, 'invalid: CALLBACK_BLOCK (format)');
    });

});

describe('prefixed MINT_START_BLOCK and MINT_STOP_BLOCK on an armed testnet ISSUE @regression @tier1', function(){

    it('keeps the representability verdicts the testnet path already returned', async function(){
        for(const v of PREFIXED.concat(['1e3', '+1000', PAST_U64])){
            assert.strictEqual((await runIssue({ params: format2(v, ''), network: 'testnet', blockTime: TESTNET_ARMED })).status,
                'invalid: MINT_START_BLOCK (format)', v);
            assert.strictEqual((await runIssue({ params: format2('', v), network: 'testnet', blockTime: TESTNET_ARMED })).status,
                'invalid: MINT_STOP_BLOCK (format)', v);
        }
        for(const v of ['1000', '01000']){
            assert.strictEqual((await runIssue({ params: format2(v, ''), network: 'testnet', blockTime: TESTNET_ARMED })).status, 'valid', v);
            assert.strictEqual((await runIssue({ params: format2('', v), network: 'testnet', blockTime: TESTNET_ARMED })).status, 'valid', v);
        }
    });

});
