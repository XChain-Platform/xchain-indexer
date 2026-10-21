/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db/ledger/issue_caret_dot_and_intern.test.js
 *
 * Batch-issuance defect pair, gated
 * behind BATCH_ISSUANCE_LIMITS:
 *
 *   - Defect A: the caret-id guard in issue.js (`^<tail>`) is isNumeric()
 *     (parseFloat-based), so a tail containing '.' (e.g. "^12.5") reads as a
 *     number and slips through, landing a status=valid ISSUE with a NULL
 *     ticker id. This suite pins the paired rejection.
 *
 *   - Defect B: getTokenInfo interns any unseen TICK via createTicker BEFORE
 *     validity is decided, so an ISSUE that has already failed some other
 *     check still burns a fresh dense ticker id for free. This suite pins the
 *     gating of that intern via indexerDb.suppressIndexIdCreation (the same
 *     resolve-only lever rollback.js's refresh phase already uses).
 *
 * Below the flag both defects must reproduce their historical (defective)
 * verdict byte-identically, since this is a consensus tightening.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');

const Issue = require('../../../../src/actions/issue/index.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH'; // createBaseData's default SOURCE
const GATE   = 'BATCH_ISSUANCE_LIMITS';

// Below the 862633 ISSUANCE_FEE mainnet activation block, so new-token issuance
// needs no GAS balance (mirrors test/unit/actions/token/issue.test.js's LOW_BLOCK).
const LOW_BLOCK = 100;

const CARET_GATE = 'ISSUE_CARET_TICK_NO_CREATE';

function makeActionsCtx(indexer, { batchLimitsActive = true, caretNoCreate = false } = {}) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().callsFake(async (name, block) => {
                if(name === 'ISSUANCE_FEE')
                    return Number(block) >= 862633;
                if(name === GATE)
                    return batchLimitsActive;
                if(name === CARET_GATE)
                    return caretNoCreate;
                return true;
            }),
        },
        processAction: sinon.stub().resolves(),
    };
}

/**
 * Build the params array for format 0 (full). Mirrors
 * test/unit/actions/token/issue.test.js's makeFormat0Params so a plain new-token
 * ISSUE reaches STATUS 'valid' with no unrelated field failures.
 */
function makeFormat0Params(overrides = {}) {
    const defaults = {
        VERSION: '0', TICK: 'TEST', MAX_SUPPLY: '1000', MAX_MINT: '100', DECIMALS: '0',
        DESCRIPTION: 'Test token', MINT_SUPPLY: '', TRANSFER: '', TRANSFER_SUPPLY: '',
        LOCK_MAX_SUPPLY: '', LOCK_MAX_MINT: '', LOCK_DESCRIPTION: '', LOCK_SLEEP: '',
        LOCK_CALLBACK: '', CALLBACK_BLOCK: '', CALLBACK_TICK: '', CALLBACK_AMOUNT: '',
        ALLOW_LIST: '', BLOCK_LIST: '', MINT_ADDRESS_MAX: '', MINT_START_BLOCK: '',
        MINT_STOP_BLOCK: '', LOCK_MINT: '', LOCK_MINT_SUPPLY: '', MEMO: '',
    };
    const merged = Object.assign({}, defaults, overrides);
    return [
        merged.VERSION, merged.TICK, merged.MAX_SUPPLY, merged.MAX_MINT, merged.DECIMALS,
        merged.DESCRIPTION, merged.MINT_SUPPLY, merged.TRANSFER, merged.TRANSFER_SUPPLY,
        merged.LOCK_MAX_SUPPLY, merged.LOCK_MAX_MINT, merged.LOCK_DESCRIPTION,
        merged.LOCK_SLEEP, merged.LOCK_CALLBACK, merged.CALLBACK_BLOCK, merged.CALLBACK_TICK,
        merged.CALLBACK_AMOUNT, merged.ALLOW_LIST, merged.BLOCK_LIST, merged.MINT_ADDRESS_MAX,
        merged.MINT_START_BLOCK, merged.MINT_STOP_BLOCK, merged.LOCK_MINT, merged.LOCK_MINT_SUPPLY,
        merged.MEMO,
    ];
}

function makeData(overrides = {}) {
    return createBaseData(Object.assign({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK }, overrides));
}

function baseSetup(indexer) {
    indexer.indexerDb.isDistributed.resolves(false);
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getAddressBalances.resolves({});
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getTokenSupply.resolves('0');
}


let indexer;
function issueHooks() {

    beforeEach(function(){
        indexer = createMockIndexer();
        baseSetup(indexer);
    });

    afterEach(function(){
        sinon.restore();
    });
}

// "^12.5" trips the parent/child split too (it contains a '.'), so the parent
// "^12" must resolve and be owned by SOURCE for the ISSUE to reach the caret-id
// check at all - exactly the coincidence worth naming ("also looks like a
// child issuance").
function stubOwnedParent(indexer, parentTick){
    indexer.indexerDb.getTokenInfo = sinon.stub().callsFake(async (tick) => {
        if(tick === parentTick)
            return createTokenInfo({ TICK: parentTick, OWNER: SOURCE });
        return null;
    });
}

// A dotted child TICK against an UNKNOWN parent fails at the parent-unknown
// check, well before the main TICK's getTokenInfo call - the exact shape the
// dotted-child exemption lets a BATCH repeat up to ~250 times per transaction.
function stubUnknownParentAndRecordSuppressState(indexer){
    const calls = [];
    indexer.indexerDb.getTokenInfo = sinon.stub().callsFake(async (tick) => {
        calls.push({ tick, suppress: indexer.indexerDb.suppressIndexIdCreation });
        return null; // parent unknown, and (if reached) TICK unknown too
    });
    return calls;
}

describe('Issue: caret-dot TICK rejection and ticker-intern gating @regression @tier1', function(){
    issueHooks();

    describe('Defect A: caret TICK containing "." (at/above the flag)', function(){
        it('"^12.5" is rejected as invalid: TICK (caret dot) when the flag is active', async function(){
            stubOwnedParent(indexer, '^12');
            const handler = new Issue(makeActionsCtx(indexer, { batchLimitsActive: true }));
            const params  = makeFormat0Params({ TICK: '^12.5' });
            const data    = makeData();

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'invalid: TICK (caret dot)');
        });

        it('"^1.0" is rejected as invalid: TICK (caret dot) when the flag is active', async function(){
            stubOwnedParent(indexer, '^1');
            const handler = new Issue(makeActionsCtx(indexer, { batchLimitsActive: true }));
            const params  = makeFormat0Params({ TICK: '^1.0' });
            const data    = makeData();

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'invalid: TICK (caret dot)');
        });
    });
});

describe('Issue: caret-dot TICK rejection and ticker-intern gating @regression @tier1', function(){
    issueHooks();

    describe('Defect A: caret TICK containing "." (at/above the flag)', function(){

        it('"^12.5" reproduces the PRE-FLAG (defective) valid verdict when the flag is off', async function(){
            stubOwnedParent(indexer, '^12');
            const handler = new Issue(makeActionsCtx(indexer, { batchLimitsActive: false }));
            const params  = makeFormat0Params({ TICK: '^12.5' });
            const data    = makeData();

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('"^1.0" reproduces the PRE-FLAG (defective) valid verdict when the flag is off', async function(){
            stubOwnedParent(indexer, '^1');
            const handler = new Issue(makeActionsCtx(indexer, { batchLimitsActive: false }));
            const params  = makeFormat0Params({ TICK: '^1.0' });
            const data    = makeData();

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});
describe('Issue: caret-dot TICK rejection and ticker-intern gating @regression @tier1', function(){
    issueHooks();

    describe('Defect A: caret TICK containing "." (at/above the flag)', function(){
        it('"^12" (no dot) is still accepted when the flag is active', async function(){
            indexer.indexerDb.getTokenInfo.resolves(null); // brand-new tick, no parent split (no '.')
            const handler = new Issue(makeActionsCtx(indexer, { batchLimitsActive: true }));
            const params  = makeFormat0Params({ TICK: '^12' });
            const data    = makeData();

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('a plain dotted child TICK ("JDOG.1") is still accepted; the caret rule does not touch it', async function(){
            indexer.indexerDb.getTokenInfo = sinon.stub().callsFake(async (tick) => {
                if(tick === 'JDOG')
                    return createTokenInfo({ TICK: 'JDOG', OWNER: SOURCE });
                return null; // JDOG.1 itself: brand new child
            });
            const handler = new Issue(makeActionsCtx(indexer, { batchLimitsActive: true }));
            const params  = makeFormat0Params({ TICK: 'JDOG.1' });
            const data    = makeData();

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});
describe('Issue: caret-dot TICK rejection and ticker-intern gating @regression @tier1', function(){
    issueHooks();

    describe('Defect B: no free ticker interning once an ISSUE has already errored', function(){

        it('performs NO ticker insert for the already-invalid TICK when the flag is active', async function(){
            const calls   = stubUnknownParentAndRecordSuppressState(indexer);
            const handler = new Issue(makeActionsCtx(indexer, { batchLimitsActive: true }));
            const params  = makeFormat0Params({ TICK: 'ORPHAN.1' });
            const data    = makeData();

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'invalid: TICK (parent unknown)');

            const parentCall = calls.find(c => c.tick === 'ORPHAN');
            const tickCall   = calls.find(c => c.tick === 'ORPHAN.1');
            assert.ok(parentCall, 'parent lookup must have run');
            assert.ok(tickCall, 'TICK lookup must have run');
            // The PARENT lookup runs BEFORE any error can be set (its own result is what
            // decides that error), so it is suppressed on the gate alone - see
            // parentGetTokenInfo. Asserting it un-suppressed here is what let the live
            // regtest run of 2026-08-14 intern "BILA3DkEqyyYxq" off a rejected ISSUE.
            assert.strictEqual(parentCall.suppress, true, 'parent lookup must be intern-suppressed under the flag');
            // error IS already set by the time the main TICK lookup runs; the intern must
            // be suppressed.
            assert.strictEqual(tickCall.suppress, true, 'TICK lookup must be intern-suppressed once error is set');

            // No leakage into the next action.
            assert.strictEqual(indexer.indexerDb.suppressIndexIdCreation, undefined);
        });
    });
});

describe('Issue: caret-dot TICK rejection and ticker-intern gating @regression @tier1', function(){
    issueHooks();

    describe('Defect B: no free ticker interning once an ISSUE has already errored', function(){

        it('still performs the ticker insert (unsuppressed) for the already-invalid TICK when the flag is OFF', async function(){
            const calls   = stubUnknownParentAndRecordSuppressState(indexer);
            const handler = new Issue(makeActionsCtx(indexer, { batchLimitsActive: false }));
            const params  = makeFormat0Params({ TICK: 'ORPHAN.1' });
            const data    = makeData();

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'invalid: TICK (parent unknown)');

            const tickCall   = calls.find(c => c.tick === 'ORPHAN.1');
            const parentCall = calls.find(c => c.tick === 'ORPHAN');
            assert.ok(tickCall, 'TICK lookup must have run');
            assert.ok(parentCall, 'parent lookup must have run');
            assert.notStrictEqual(tickCall.suppress, true, 'below the flag the intern must NOT be suppressed (pre-flag behavior)');
            assert.notStrictEqual(parentCall.suppress, true, 'below the flag the parent intern must NOT be suppressed either');
        });
    });
});

describe('Issue: caret TICK may not create a token (ISSUE_CARET_TICK_NO_CREATE) @regression @tier1', function(){
    issueHooks();

    // 'ISSUE PARENT.X' by a non-owner is rejected but interns PARENT.X as ticker id N, so
    // 'ISSUE ^N' resolves a name that has no token row.
    async function rejectedChildThenCaret(caretNoCreate){
        const created = sinon.spy();
        indexer.indexerDb.createToken = created;
        indexer.indexerDb.getTokenInfo = sinon.stub().callsFake(async (tick) => {
            if(tick === 'PARENT')
                return createTokenInfo({ TICK: 'PARENT', OWNER: 'mnotTheOwnerxxxxxxxxxxxxxxxxxxxxxx' });
            return null;
        });
        const handler = new Issue(makeActionsCtx(indexer, { caretNoCreate }));

        const first = makeData();
        await handler.parse(makeFormat0Params({ TICK: 'PARENT.X' }), first, null);
        assert.strictEqual(first.STATUS, 'invalid: TICK (parent issued by another address)');

        const second = makeData();
        await handler.parse(makeFormat0Params({ TICK: '^7' }), second, null);
        return { second, created };
    }

    it('is invalid: TICK (unknown) and never calls createToken when the flag is on', async function(){
        const { second, created } = await rejectedChildThenCaret(true);
        assert.strictEqual(second.STATUS, 'invalid: TICK (unknown)');
        assert.strictEqual(created.callCount, 0);
    });

    it('stays valid when the flag is off', async function(){
        const { second } = await rejectedChildThenCaret(false);
        assert.strictEqual(second.STATUS, 'valid');
    });

    it('an owner caret v1 edit of an existing token stays valid with the flag on', async function(){
        indexer.indexerDb.getTokenInfo = sinon.stub().callsFake(async (tick) =>
            tick === '^7' ? createTokenInfo({ TICK: 'EXISTING', OWNER: SOURCE }) : null);
        const handler = new Issue(makeActionsCtx(indexer, { caretNoCreate: true }));
        const data = makeData({ FORMAT: 1 });

        await handler.parse(['1', '^7', 'new description', ''], data, null);

        assert.strictEqual(data.STATUS, 'valid');
    });
});
