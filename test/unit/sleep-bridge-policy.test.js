'use strict';

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
 * test/unit/sleep-bridge-policy.test.js
 *
 * SLEEP's half of policy inheritance (policy spec section 12 row 2).
 *
 * A bridged copy is created with LOCK_SLEEP set, so nobody can ever pause the copy
 * by hand. That lock is also, unamended, a refusal of the one thing the copy exists
 * to receive: policy inheritance materializes the ORIGIN's sleep state onto the copy
 * with an injected SLEEP format 1 routed through processTransaction(tx, true), and
 * the LOCK_SLEEP guard would refuse it. The guard therefore gains an IS_GENESIS term.
 *
 * The obligation the negative cases carry: no broadcast action ever carries the flag,
 * so the exemption must be invisible to every wire SLEEP on every network. A term that
 * leaked to a broadcast would let an owner pause a token they promised never to pause,
 * which is the whole hole the LOCK_SLEEP guard was added to close.
 ********************************************************************/

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');
const Sleep = require('../../src/actions/sleep.js');

const OWNER    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const STRANGER = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

function makeActionsCtx(indexer){
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: indexer.protocolChanges,
    };
}

// SLEEP format 1: VERSION|RESUME_BLOCK|TICK|MEMO. RESUME_BLOCK 600 is ahead of the
// drill's block 500, which is what the recency check wants.
function sleepTick(tick = 'BTC.FUFU', resumeBlock = '600'){
    return ['1', resumeBlock, tick, ''];
}

// The bridged copy's row: owned by this chain's BTC bridge role address and created
// with LOCK_SLEEP set, exactly as the in-leg creates it.
function copyRow(o = {}){
    return Object.assign({
        TICK: 'BTC.FUFU', TICK_ID: 11, OWNER: OWNER, MAX_SUPPLY: '1000', MAX_MINT: '0',
        DECIMALS: 8, DESCRIPTION: 'bridged copy', SUPPLY: '10',
        LOCK_MAX_SUPPLY: 1, LOCK_MINT: 1, LOCK_MINT_SUPPLY: 1, LOCK_MAX_MINT: 1,
        LOCK_DESCRIPTION: 1, LOCK_SLEEP: 1, LOCK_CALLBACK: 1, LOCK_BRIDGE: 1,
        ALLOW_LIST: null, BLOCK_LIST: null, BRIDGE_CHAINS: null, MIN_DEPTH: null, BRIDGED: 0
    }, o);
}

async function run({ params = sleepTick(), token = copyRow(), source = OWNER, isGenesis = false, network = 'regtest' } = {}){
    const indexer = createMockIndexer();
    indexer.config.NETWORK = network;
    indexer.indexerDb.getTokenInfo.resolves(token);
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.isOwnershipEscrowed.resolves(false);

    const handler = new Sleep(makeActionsCtx(indexer));
    const d = createBaseData({
        ACTION: 'SLEEP', FORMAT: Number(params[0]), BLOCK_INDEX: 500,
        SOURCE: source, IS_GENESIS: isGenesis
    });
    await handler.parse(params, d, null);
    return d.STATUS;
}

describe('SLEEP LOCK_SLEEP guard and the policy-inheritance exemption @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    it('still refuses a broadcast TICK sleep of a LOCK_SLEEP token', async function(){
        assert.strictEqual(await run(), 'invalid: LOCK_SLEEP');
    });

    it('still refuses it on mainnet, so the guard is not a regtest-only rule', async function(){
        assert.strictEqual(await run({ network: 'mainnet' }), 'invalid: LOCK_SLEEP');
    });

    it('still refuses the indefinite shape, which is the freeze the guard exists to stop', async function(){
        // SLEEP|1|-1|TICK is the one that never resumes on its own.
        assert.strictEqual(await run({ params: sleepTick('BTC.FUFU', '-1') }), 'invalid: LOCK_SLEEP');
    });

    it('admits the injected sleep that materializes the origin state onto the copy', async function(){
        assert.strictEqual(await run({ isGenesis: true }), 'valid');
    });

    it('admits the injected indefinite sleep, the shape an asleep origin carries', async function(){
        assert.strictEqual(await run({ params: sleepTick('BTC.FUFU', '-1'), isGenesis: true }), 'valid');
    });

    it('admits the injected WAKE shape, a resume block equal to this block', async function(){
        // Inheritance carries "awake" as well as "asleep": a resume block at the applying
        // block is the wake, and it has to pass the same lock the sleep does.
        assert.strictEqual(await run({ params: sleepTick('BTC.FUFU', '500'), isGenesis: true }), 'valid');
    });

    it('leaves an unlocked token alone in both directions', async function(){
        assert.strictEqual(await run({ token: copyRow({ LOCK_SLEEP: 0 }) }), 'valid');
        assert.strictEqual(await run({ token: copyRow({ LOCK_SLEEP: 0 }), isGenesis: true }), 'valid');
    });

    it('does not let the exemption bypass the owner check', async function(){
        // IS_GENESIS exempts the LOCK_SLEEP term only. The owner check above it stands on
        // its own, and it passes for the real injection because the bridge role address IS
        // the copy's owner; a stranger is still refused whatever the flag says.
        assert.strictEqual(await run({ source: STRANGER, isGenesis: true }), 'invalid: TICK (not authorized)');
    });

    it('does not touch an ADDRESS sleep, which carries no TICK at all', async function(){
        // SLEEP format 0: VERSION|RESUME_BLOCK|MEMO. TYPE is ADDRESS, so neither the guard
        // nor its new term can fire.
        assert.strictEqual(await run({ params: ['0', '600', ''] }), 'valid');
    });
});
