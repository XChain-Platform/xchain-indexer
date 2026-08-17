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
 * test/unit/issueCaretDotAndIntern.test.js
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

const { createMockIndexer, createBaseData, createTokenInfo } = require('../fixtures/mocks');

const Issue = require('../../src/actions/issue.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH'; // createBaseData's default SOURCE
const GATE   = 'BATCH_ISSUANCE_LIMITS';

// Below the 862633 ISSUANCE_FEE mainnet activation block, so new-token issuance
// needs no GAS balance (mirrors test/unit/actions/issue.test.js's LOW_BLOCK).
const LOW_BLOCK = 100;

function makeActionsCtx(indexer, { batchLimitsActive = true } = {}) {
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
                return true;
            }),
        },
        processAction: sinon.stub().resolves(),
    };
}

/**
 * Build the params array for format 0 (full). Mirrors
 * test/unit/actions/issue.test.js's makeFormat0Params so a plain new-token
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

describe('Issue: caret-dot TICK rejection and ticker-intern gating @regression @tier1', function(){

    let indexer;

    beforeEach(function(){
        indexer = createMockIndexer();
        baseSetup(indexer);
    });

    afterEach(function(){
        sinon.restore();
    });

    describe('Defect A: caret TICK containing "." (at/above the flag)', function(){

        // "^12.5" trips the parent/child split too (it contains a '.'), so the parent
        // "^12" must resolve and be owned by SOURCE for the ISSUE to reach the caret-id
        // check at all - exactly the coincidence review F4 describes ("also looks like a
        // child issuance").
        function stubOwnedParent(indexer, parentTick){
            indexer.indexerDb.getTokenInfo = sinon.stub().callsFake(async (tick) => {
                if(tick === parentTick)
                    return createTokenInfo({ TICK: parentTick, OWNER: SOURCE });
                return null;
            });
        }

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

    describe('Defect B: no free ticker interning once an ISSUE has already errored', function(){

        // A dotted child TICK against an UNKNOWN parent fails at the parent-unknown
        // check, well before the main TICK's getTokenInfo call - the exact shape R1's
        // dotted-child exemption lets a BATCH repeat up to ~250 times per transaction.
        function stubUnknownParentAndRecordSuppressState(indexer){
            const calls = [];
            indexer.indexerDb.getTokenInfo = sinon.stub().callsFake(async (tick) => {
                calls.push({ tick, suppress: indexer.indexerDb.suppressIndexIdCreation });
                return null; // parent unknown, and (if reached) TICK unknown too
            });
            return calls;
        }

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

    // The wrapper above is conditioned on `error`, and the parent
    // lookup is the one call site where `error` can never yet be set, so it needed a
    // suppression condition of its own. These cases pin that the condition is the GATE,
    // not the error, and that it costs the valid paths nothing.
    describe('Defect B2: the parent lookup interns nothing on its own', function(){

        it('suppresses the parent-name intern even though no error has been set yet', async function(){
            const seen = [];
            indexer.indexerDb.getTokenInfo = sinon.stub().callsFake(async (tick) => {
                seen.push({ tick, suppress: indexer.indexerDb.suppressIndexIdCreation });
                return null;
            });
            const handler = new Issue(makeActionsCtx(indexer, { batchLimitsActive: true }));

            await handler.parse(makeFormat0Params({ TICK: 'ORPHAN.1' }), makeData(), null);

            const parentCall = seen.find(c => c.tick === 'ORPHAN');
            assert.ok(parentCall, 'parent lookup must have run');
            assert.strictEqual(parentCall.suppress, true,
                'an unknown parent must never be interned: the ISSUE naming it is always rejected');
            assert.strictEqual(indexer.indexerDb.suppressIndexIdCreation, undefined,
                'suppression must not leak past the call');
        });

        it('still resolves an EXISTING parent through the suppressed lookup, so valid children are unaffected', async function(){
            // Resolve-only suppression blocks the INSERT, never the SELECT. A parent that
            // exists is already interned, so a valid child issuance reads it back normally.
            indexer.indexerDb.getTokenInfo = sinon.stub().callsFake(async (tick) => {
                if(tick === 'JDOG')
                    return createTokenInfo({ TICK: 'JDOG', OWNER: SOURCE });
                return null;
            });
            const handler = new Issue(makeActionsCtx(indexer, { batchLimitsActive: true }));
            const data    = makeData();

            await handler.parse(makeFormat0Params({ TICK: 'JDOG.1' }), data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('reports the parent-unknown verdict identically with the flag on and off', async function(){
            // The suppression changes a side effect only; the verdict must not move, or
            // this would be a consensus change in the verdicts rather than in the ids.
            for(const batchLimitsActive of [true, false]){
                indexer.indexerDb.getTokenInfo = sinon.stub().resolves(null);
                const handler = new Issue(makeActionsCtx(indexer, { batchLimitsActive }));
                const data    = makeData();

                await handler.parse(makeFormat0Params({ TICK: 'ORPHAN.1' }), data, null);

                assert.strictEqual(data.STATUS, 'invalid: TICK (parent unknown)',
                    'verdict must be identical with the flag ' + (batchLimitsActive ? 'on' : 'off'));
            }
        });
    });
});
