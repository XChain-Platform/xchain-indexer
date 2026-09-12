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
 * test/unit/issue-bridge-namespace.test.js
 *
 * The TICK NAMESPACE rules (token-bridge spec section 3, R8) and the
 * acceptance cases AT6 names for them. Two rules on one activation:
 *
 *   1. a FOUR-CHARACTER FLOOR on a new top-level name, refused with the existing
 *      'invalid: TICK (length)' string, measured on the FULL tick and creation only;
 *   2. RESERVED_FUTURE_ROOTS joined to the reserved guard, case-folded per D13, with
 *      the existing 'invalid: TICK (reserved)' string reused.
 *
 * WHAT THESE CASES ARE FOR, beyond "the guard fires": both rules are keyed on
 * TICK_NAMESPACE_ACTIVATION precisely because the length and reserved checks run
 * BEFORE the fee and budget checks (D49), so an ISSUE of a short or listed name that
 * a live chain already refused on fee would flip its verdict string on replay if the
 * guard were unconditional. That is why every positive case here has a negative twin
 * driven with the predicate off: the below-the-flag reading is the real obligation,
 * and a guard that leaks below its flag is a fork, not a bug.
 *
 * The activation predicate is stubbed per case rather than driven by height, because
 * the map parks at regtest 0 and the house sentinel everywhere else: there is no
 * (regtest, height) pair that reads inactive, so the below-the-flag half of every
 * pair would be unreachable otherwise.
 ********************************************************************/

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');
const Issue                   = require('../../src/actions/issue.js');
const tickNamespaceActivation = require('../../src/tick_namespace_activation.js');
const { RESERVED_FUTURE_ROOTS, isReservedFutureRoot } = require('../../src/reservedRoots.js');

const OWNER = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

// The interned id of the gas ticker in this fixture. Only its identity matters: the fee
// object looks the id up and the balance map is keyed by it.
const FEE_TICK_ID = 1;

function makeActionsCtx(indexer){
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: indexer.protocolChanges,
        processAction:   sinon.stub().resolves(),
    };
}

// ISSUE format 0 (the CREATE form): the only form that can register a new name, and
// therefore the only one the floor can bind on.
// VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|
// LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|
// CALLBACK_TICK|CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|
// MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
function create(tick){
    return ['0', tick, '1000', '100', '0', 'namespace drill', '0',
            '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
}

// ISSUE format 1 (DESCRIPTION edit): an edit of a row that already exists, which is
// what the "creation only" half of R8 (c) protects.
function edit(tick){
    return ['1', tick, 'edited description', ''];
}

// Drive one ISSUE. `existing` is the row getTokenInfo resolves for the tick under
// test; null means the name is unregistered, which is the creation case.
async function run({ params, existing = null, active = true, data = {}, coin = 'BTC', network = 'regtest' } = {}){
    const indexer = createMockIndexer();
    indexer.config.COIN    = coin;
    indexer.config.NETWORK = network;
    indexer.indexerDb.getTokenInfo.resolves(existing);
    indexer.indexerDb.isValidList.resolves(true);
    // A format 0 create pays the issuance fee out of the source's gas balance, and the fee
    // check runs AFTER the namespace guard. Fund it, or every positive case reads
    // 'invalid: insufficient funds (FEE)' and proves nothing about the guard under test.
    indexer.indexerDb.getTickerId.resolves(FEE_TICK_ID);
    indexer.indexerDb.getAddressBalances.resolves({ [FEE_TICK_ID]: '100000000' });

    // One `it` drives several ISSUEs, so the predicate is re-stubbed per call; sinon
    // refuses to wrap an already-wrapped method, hence the explicit restore.
    if(tickNamespaceActivation.isTickNamespaceActive.restore)
        tickNamespaceActivation.isTickNamespaceActive.restore();
    sinon.stub(tickNamespaceActivation, 'isTickNamespaceActive').returns(active);

    const handler = new Issue(makeActionsCtx(indexer));
    const d = createBaseData(Object.assign({ ACTION: 'ISSUE', FORMAT: Number(params[0]), BLOCK_INDEX: 500, SOURCE: OWNER }, data));
    await handler.parse(params, d, null);
    return d.STATUS;
}

// The row getTokenInfo hands back for a name that already exists. Only the fields the
// ISSUE path reads on an edit matter; OWNER has to be the source or the edit is refused
// for a different reason and the case proves nothing about the namespace guard.
function tokenRow(tick){
    return {
        TICK: tick, TICK_ID: 9, OWNER: OWNER, MAX_SUPPLY: '1000', MAX_MINT: '100',
        DECIMALS: 0, DESCRIPTION: 'pre-flag row', SUPPLY: '0',
        LOCK_MAX_SUPPLY: 0, LOCK_MINT: 0, LOCK_MINT_SUPPLY: 0, LOCK_MAX_MINT: 0,
        LOCK_DESCRIPTION: 0, LOCK_SLEEP: 0, LOCK_CALLBACK: 0, LOCK_BRIDGE: 0,
        ALLOW_LIST: null, BLOCK_LIST: null, BRIDGE_CHAINS: null, MIN_DEPTH: null,
        BRIDGED: 0, MINT_ADDRESS_MAX: 0, MINT_START_BLOCK: 0, MINT_STOP_BLOCK: 0,
        CALLBACK_BLOCK: 0, CALLBACK_TICK: null, CALLBACK_AMOUNT: 0
    };
}

describe('ISSUE tick namespace: the four-character floor and the reserved future roots @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('RESERVED_FUTURE_ROOTS (AT6)', function(){

        it('refuses a listed chain root from a user', async function(){
            assert.strictEqual(await run({ params: create('ETH') }), 'invalid: TICK (reserved)');
        });

        it('refuses it case-folded, so the lower-case spelling cannot take the row', async function(){
            assert.strictEqual(await run({ params: create('eth') }), 'invalid: TICK (reserved)');
        });

        it('refuses a four-letter listed root the length floor does not cover', async function(){
            assert.strictEqual(await run({ params: create('BASE') }), 'invalid: TICK (reserved)');
        });

        it('lets the reserved verdict win over the length verdict when a name is both', async function(){
            // ETH is three characters AND a listed chain code. The reserved string says WHY
            // the name is held, which is the answer an issuer can act on; AT6 pins it.
            assert.strictEqual(await run({ params: create('ETH') }), 'invalid: TICK (reserved)');
            assert.strictEqual(await run({ params: create('ABC') }), 'invalid: TICK (length)');
        });

        it('refuses a child of a reserved root through the parent gate, not through this guard', async function(){
            // One entry per chain reserves the whole ROOT.* subtree: the parent lookup runs
            // first and finds nothing, so the subtree costs no list entries at all.
            assert.strictEqual(await run({ params: create('ETH.ANY') }), 'invalid: TICK (parent unknown)');
        });

        it('reads exactly as it does today below the flag', async function(){
            assert.notStrictEqual(await run({ params: create('ETH'),  active: false }), 'invalid: TICK (reserved)');
            assert.notStrictEqual(await run({ params: create('eth'),  active: false }), 'invalid: TICK (reserved)');
            assert.notStrictEqual(await run({ params: create('BASE'), active: false }), 'invalid: TICK (reserved)');
        });
    });

    describe('the four-character floor (AT6)', function(){

        it('refuses a three-character new top-level name', async function(){
            assert.strictEqual(await run({ params: create('ABC') }), 'invalid: TICK (length)');
        });

        it('refuses a one-character new top-level name', async function(){
            assert.strictEqual(await run({ params: create('Z') }), 'invalid: TICK (length)');
        });

        it('admits a four-character new top-level name', async function(){
            assert.strictEqual(await run({ params: create('ABCD') }), 'valid');
        });

        it('measures the FULL tick, so a short child of a long parent passes', async function(){
            // ABCD.X is six characters and its own segment is one; the floor is on the tick,
            // not on the leaf, which is what keeps bulk child issuance working.
            assert.strictEqual(await run({ params: create('ABCD.X'), existing: tokenRow('ABCD') }), 'valid');
        });

        it('reads exactly as it does today below the flag', async function(){
            assert.notStrictEqual(await run({ params: create('ABC'), active: false }), 'invalid: TICK (length)');
            assert.notStrictEqual(await run({ params: create('Z'),   active: false }), 'invalid: TICK (length)');
        });
    });

    describe('creation only (R8 (c), D50)', function(){

        it('leaves an edit of a pre-flag three-character row alone', async function(){
            assert.strictEqual(await run({ params: edit('ABC'), existing: tokenRow('ABC') }), 'valid');
        });

        it('leaves a caret id reference alone, which is always an edit of an existing row', async function(){
            assert.strictEqual(await run({ params: edit('^12'), existing: tokenRow('^12') }), 'valid');
        });

        it('leaves an edit of one of the six reclaimed listed rows alone', async function(){
            // Between this guard and the genesis manifest edit the six squatted
            // rows still exist and still have owners; the guard blocks NEW issuance only.
            assert.strictEqual(await run({ params: edit('DASH'), existing: tokenRow('DASH') }), 'valid');
        });

        it('still refuses a re-ISSUE of a listed name that does NOT exist', async function(){
            assert.strictEqual(await run({ params: edit('ETH'), existing: null }), 'invalid: TICK (reserved)');
        });
    });

    describe('system-injected creation', function(){

        it('is exempt, which is how a bridge root row is made on a destination chain', async function(){
            // The in-leg creates BTC on DOGE through processTransaction(tx, true). Three
            // characters and, for a chain not yet integrated, a listed name: without the
            // exemption the bridge could not create the row it is built to create.
            assert.notStrictEqual(await run({ params: create('ETH'), data: { IS_GENESIS: true } }), 'invalid: TICK (reserved)');
            assert.notStrictEqual(await run({ params: create('ABC'), data: { IS_GENESIS: true } }), 'invalid: TICK (length)');
        });
    });

    describe('the reserved set itself', function(){

        it('holds the 47 free roots plus the 6 reclaimed ones, none of them a live coin', async function(){
            assert.strictEqual(RESERVED_FUTURE_ROOTS.length, 53);
            // A live coin belongs in COINS, not here: a name in both would be refused twice
            // for two different reasons and the move from one to the other would not be the
            // no-op the spec promises.
            const indexer = createMockIndexer();
            for(const coin of (indexer.config.COINS || []))
                assert.strictEqual(isReservedFutureRoot(coin), false, coin + ' is a live coin and must not be in RESERVED_FUTURE_ROOTS');
        });

        it('is frozen, so no caller can edit a consensus membership test at runtime', async function(){
            assert.strictEqual(Object.isFrozen(RESERVED_FUTURE_ROOTS), true);
        });
    });
});
