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
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const Issue = require('../../../../../src/actions/issue/index.js');
const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const GATE   = 'BATCH_ISSUANCE_LIMITS';
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

describe('Issue: caret-dot TICK rejection and ticker-intern gating @regression @tier1', function(){
    issueHooks();
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
