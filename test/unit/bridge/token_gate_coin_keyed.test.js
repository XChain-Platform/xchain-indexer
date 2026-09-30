/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The token-bridge gates are keyed '<COIN>:<network>' and the arming tool writes only the
 * per-chain testnet slots, leaving the bare testnet fallback dark. Every reader must hand
 * the registry this chain's coin, or it reads the dark fallback forever. Each case stubs
 * the registry read to answer by the COIN argument, so a coin-blind call cannot pass.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { stubGate } = require('../../helpers/gate_modules.js');
const { DEST, makeHandler, makeData } = require('../actions/bridge/xbridge.test/helpers/xbridge_context.js');
const { parseWire } = require('../../../src/actions/issue/wire.js');
const ledgerChecks  = require('../../../src/db/database/ledger_checks.js');
const {
    BS, makeKey, makeTransfer, snapshotSet, makeCtx, buildProof, ESCROW_BTC_ON_DOGE
} = require('./bridge_settle.test/helpers/settle_fixtures.js');

const TOKEN_BRIDGE_KEY  = 'token_bridge_activation.TOKEN_BRIDGE_ACTIVATION';
const TOKEN_POLICY_KEY  = 'token_policy_activation.TOKEN_POLICY_INHERITANCE_ACTIVATION';
const LIST_DETACH_KEY   = 'issue_policy_list_detach.ISSUE_POLICY_LIST_DETACH';
const NAMESPACE_KEY     = 'tick_namespace_activation.TICK_NAMESPACE_ACTIVATION';
const BEFORE_ACTIVATION = 'invalid: XBRIDGE before activation';

// Every activeAt() call under `src` that names one of the four gates with a literal null coin.
function nullCoinReads(src){
    const keys = new Set([TOKEN_BRIDGE_KEY, TOKEN_POLICY_KEY, LIST_DETACH_KEY, NAMESPACE_KEY]);
    const hits = [];
    const walk = (dir) => {
        for(const e of fs.readdirSync(dir, { withFileTypes: true })){
            const p = path.join(dir, e.name);
            if(e.isDirectory()) { walk(p); continue; }
            if(e.name.endsWith('.js')) hits.push(...fileNullCoinReads(p, src, keys));
        }
    };
    walk(src);
    return hits;
}

// The null-coin reads of `keys` in one file, as 'relative/path.js:line'.
function fileNullCoinReads(file, src, keys){
    const text = fs.readFileSync(file, 'utf8');
    const re = /activeAt\(\s*([A-Za-z_]\w*|'[^']+')\s*,\s*[^,]+,\s*null\s*,/g;
    const out = [];
    let m;
    while((m = re.exec(text))){
        let key = m[1];
        if(key.startsWith("'")) key = key.slice(1, -1);
        else {
            const d = new RegExp('(?:const|let|var)\\s+' + key + "\\s*=\\s*'([^']+)'").exec(text);
            key = d ? d[1] : key;
        }
        if(keys.has(key)) out.push(path.relative(src, file) + ':' + text.slice(0, m.index).split('\n').length);
    }
    return out;
}

// Armed for one coin only, the state the arming tool leaves behind for a per-chain height.
function armOnly(key, armedCoin){
    return stubGate(sinon, key, false).callsFake((k, network, coin) => coin === armedCoin);
}

describe('token-bridge gates read per chain @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('XBRIDGE v3/v4 (TOKEN_BRIDGE_ACTIVATION)', function(){
        it('admits v3 and v4 on the armed chain and refuses them on a sibling chain', async function(){
            armOnly(TOKEN_BRIDGE_KEY, 'LTC');
            for(const format of [3, 4]){
                const params = (format === 3) ? ['3', 'FUFU', 'DOGE', DEST, '1', ''] : ['4', 'BTC.FUFU', DEST, '1', ''];

                const ltc = makeHandler({ coin: 'LTC', network: 'testnet' });
                const ltcData = makeData(format, 'LTC');
                await ltc.handler.parse(params, ltcData, null);
                assert.notStrictEqual(ltcData['STATUS'], BEFORE_ACTIVATION, 'LTC v' + format + ' must pass the armed LTC slot');

                for(const coin of ['BTC', 'DOGE']){
                    const other = makeHandler({ coin: coin, network: 'testnet' });
                    const otherData = makeData(format, coin);
                    await other.handler.parse(params, otherData, null);
                    assert.strictEqual(otherData['STATUS'], BEFORE_ACTIVATION, coin + ' v' + format + ' must not inherit the LTC slot');
                }
            }
        });
    });

});

describe('token-bridge gates read per chain @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('ISSUE flag days (parseWire)', function(){
        function wireThis(coin){
            return {
                config:  { NETWORK: 'testnet', COIN: coin },
                formats: { 7: 'VERSION|TICK|BRIDGE_CHAINS|MIN_DEPTH|LOCK_BRIDGE' },
                util:    { setActionParams: (data) => data },
            };
        }

        it('resolves all four flag days with this chain\'s coin', async function(){
            for(const key of [TOKEN_BRIDGE_KEY, TOKEN_POLICY_KEY, LIST_DETACH_KEY, NAMESPACE_KEY]) armOnly(key, 'LTC');

            const ltc = await parseWire.call(wireThis('LTC'), [], { FORMAT: 7, BLOCK_INDEX: 100 }, null);
            assert.strictEqual(ltc.tokenBridgeActive, true);
            assert.strictEqual(ltc.policyInheritance, true);
            assert.strictEqual(ltc.policyListDetach, true);
            assert.strictEqual(ltc.namespaceActive, true);
            assert.strictEqual(ltc.error, null, 'format 7 must parse on the armed chain');

            const btc = await parseWire.call(wireThis('BTC'), [], { FORMAT: 7, BLOCK_INDEX: 100 }, null);
            assert.strictEqual(btc.tokenBridgeActive, false);
            assert.strictEqual(btc.policyInheritance, false);
            assert.strictEqual(btc.policyListDetach, false);
            assert.strictEqual(btc.namespaceActive, false);
            assert.strictEqual(btc.error, 'invalid: VERSION (unknown)', 'format 7 stays unknown on a dark chain');
        });
    });

});

describe('token-bridge gates read per chain @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('isAnyCoinAddress (TOKEN_POLICY_INHERITANCE_ACTIVATION)', function(){
        function checksThis(coin){
            return {
                config: { NETWORK: 'testnet', COIN: coin, COINS: ['BTC', 'LTC', 'DOGE'] },
                util:   { isCryptoAddress: (address, c) => (c === 'DOGE' && address === 'D-addr') },
            };
        }

        it('widens to foreign-chain addresses only where the chain\'s own slot is armed', function(){
            armOnly(TOKEN_POLICY_KEY, 'LTC');
            assert.strictEqual(ledgerChecks.isAnyCoinAddress.call(checksThis('LTC'), 'D-addr', 100), true);
            assert.strictEqual(ledgerChecks.isAnyCoinAddress.call(checksThis('BTC'), 'D-addr', 100), false);
        });
    });

});

describe('token-bridge gates read per chain @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('the in-leg policy barrier (bridge_settle/transfer.js)', function(){
        function inLeg(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row = makeTransfer(keys, { tick: 'PEPECASH', decimals: 2, amount: '5.00' });
            const { ctx } = makeCtx({
                coin: 'DOGE',
                validators: snapshotSet(keys),
                tokens: {
                    'BTC.PEPECASH': { TICK_ID: 9, DECIMALS: 2, SUPPLY: '0' },
                    'BTC': { TICK_ID: 8, DECIMALS: 0, SUPPLY: '0', OWNER: ESCROW_BTC_ON_DOGE }
                }
            });
            ctx.proof = buildProof('9.00', 'PEPECASH');
            const reads = [];
            ctx.indexerDb.getAppliedPolicySnapshot = async (origin, tick) => { reads.push([origin, tick]); return null; };
            return { row, ctx, reads };
        }

        it('holds a general-token in-leg when THIS chain\'s policy slot is armed', async function(){
            armOnly(TOKEN_POLICY_KEY, 'DOGE');
            const { row, ctx, reads } = inLeg();
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.IN_LEG_NO_POLICY);
            assert.deepStrictEqual(reads, [['BTC', 'PEPECASH']]);
        });

        it('does not hold it when only a sibling chain\'s slot is armed', async function(){
            armOnly(TOKEN_POLICY_KEY, 'BTC');
            const { row, ctx, reads } = inLeg();
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.notStrictEqual(res.reason, BS.SETTLE_REASON.IN_LEG_NO_POLICY);
            assert.deepStrictEqual(reads, [], 'a dark chain must never consult the policy snapshot');
        });
    });

});

describe('token-bridge gates read per chain @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('source guard', function(){
        // Every activeAt() read of these four gates in src/ names a coin, never a literal null.
        it('finds no null-coin read of a token-bridge gate', function(){
            assert.deepStrictEqual(nullCoinReads(path.join(__dirname, '..', '..', '..', 'src')), []);
        });
    });
});
