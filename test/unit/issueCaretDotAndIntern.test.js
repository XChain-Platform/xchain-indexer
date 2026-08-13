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
 * XC-1457 / R6 (frontier row 6 of claude/specs/batch-issuance-limits.md), gated
 * behind BATCH_ISSUANCE_LIMITS_V2:
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
const GATE   = 'BATCH_ISSUANCE_LIMITS_V2';

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

describe('Issue: caret-dot TICK rejection and ticker-intern gating (XC-1457/R6) @regression @tier1', function(){

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
            // error is not yet set when the PARENT lookup itself runs (its result is what
            // decides the error), so that call must be un-suppressed.
            assert.strictEqual(parentCall.suppress, undefined, 'parent lookup must not be suppressed (error not yet set)');
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

            const tickCall = calls.find(c => c.tick === 'ORPHAN.1');
            assert.ok(tickCall, 'TICK lookup must have run');
            assert.notStrictEqual(tickCall.suppress, true, 'below the flag the intern must NOT be suppressed (pre-flag behavior)');
        });
    });
});
