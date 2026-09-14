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
 * test/unit/emission_issuance_limits.test/issue_budget.test.js
 *
 * The rule at its choke point (issue.js): one top-level tick per budget, dotted
 * children exempt, caret ticks never exempt, genesis exempt, gate-off identity.
 * Part of the emission-issuance-budget suite; see
 * ../emission_issuance_limits.test.js, whose describe title each block here
 * repeats so every full test title is unchanged.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const { GATE, LOW_BLOCK } = require('./helpers/emission_budget_fixtures.js');

const Issue = require('../../../src/actions/issue.js');

let indexer, actionsCtx, handler, gateOn;

// Format 1 (VERSION|TICK|DESCRIPTION|MEMO) is the shortest ISSUE that reaches the
// counter; the budget is decided on the TICK alone, so the rest of the format is noise.
function issueParams(tick){
    return ['1', tick, 'a token', ''];
}

function issueData(ledger, overrides = {}){
    const data = createBaseData(Object.assign({
        ACTION:      'ISSUE',
        FORMAT:      1,
        BLOCK_INDEX: LOW_BLOCK,
    }, overrides));
    if(ledger) data['ISSUANCE_LIMIT_LEDGER'] = ledger;
    return data;
}

// A fresh ISSUE handler whose gate answers `gateOn`, with the token reads a new
// top-level name sees.
function freshIssue(){
    gateOn     = true;
    indexer    = createMockIndexer();
    actionsCtx = {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().callsFake(async (name, block) => {
                if(name === GATE)           return gateOn;
                if(name === 'ISSUANCE_FEE') return Number(block) >= 862633;
                return true;
            }),
        },
        processAction: sinon.stub().resolves(),
    };
    handler = new Issue(actionsCtx);

    indexer.indexerDb.getTokenInfo.resolves(null);
    indexer.indexerDb.isDistributed.resolves(false);
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.isOwnershipEscrowed.resolves(false);
    indexer.indexerDb.getAddressBalances.resolves({});
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getTokenSupply.resolves('0');
}

function restoreStubs(){
    sinon.restore();
}

/*****************************************************************
 * The rule, at its choke point
 ****************************************************************/

describe('EMISSION_ISSUANCE_LIMITS budget in issue.js @regression @tier1', function () {
    beforeEach(freshIssue);
    afterEach(restoreStubs);

    it('the first top-level issuance in a budget is admitted and consumes the slot', async function () {
        const ledger = { topLevel: 0 };
        const data   = issueData(ledger);

        await handler.parse(issueParams('ALPHA'), data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(ledger.topLevel, 1);
    });

    it('a SECOND top-level issuance drawing on the same budget is refused', async function () {
        // This is the defect: before the gate both of these landed, and 50 of them landed
        // out of one EXECUTE.
        const ledger = { topLevel: 0 };

        const first = issueData(ledger);
        await handler.parse(issueParams('ALPHA'), first, null);
        assert.strictEqual(first.STATUS, 'valid');

        const second = issueData(ledger);
        await handler.parse(issueParams('BETA'), second, null);
        assert.strictEqual(second.STATUS, 'invalid: ISSUE (limit)');
    });

});

describe('EMISSION_ISSUANCE_LIMITS budget in issue.js @regression @tier1', function () {
    beforeEach(freshIssue);
    afterEach(restoreStubs);

    it('a refused issuance never interns a ticker id for the name it did not register', async function () {
        // The budget check runs BEFORE the token-info read precisely so gatedGetTokenInfo
        // sees `error` already set and switches to resolve-only, which is what stops a
        // refused name from consuming dense ticker-id space for free. Placed after the read
        // this assertion goes red, which is the point of asserting it.
        let suppressedAtRead = null;
        indexer.indexerDb.getTokenInfo.callsFake(async () => {
            suppressedAtRead = indexer.indexerDb.suppressIndexIdCreation === true;
            return null;
        });

        const ledger = { topLevel: 1 };   // budget already spent
        const data   = issueData(ledger);

        await handler.parse(issueParams('BETA'), data, null);

        assert.strictEqual(data.STATUS, 'invalid: ISSUE (limit)');
        assert.strictEqual(suppressedAtRead, true, 'the TICK read must run resolve-only');
    });

    it('DOTTED child ticks are exempt: many children fit beside one top-level name', async function () {
        const ledger = { topLevel: 0 };

        const parent = issueData(ledger);
        await handler.parse(issueParams('ALPHA'), parent, null);
        assert.strictEqual(parent.STATUS, 'valid');

        // The parent must exist and be owned by SOURCE for a child issuance to validate.
        indexer.indexerDb.getTokenInfo.resolves({ TICK: 'ALPHA', TICK_ID: 1, OWNER: parent.SOURCE });

        for(const tick of ['ALPHA.1', 'ALPHA.2', 'ALPHA.3']){
            const child = issueData(ledger);
            await handler.parse(issueParams(tick), child, null);
            assert.notStrictEqual(child.STATUS, 'invalid: ISSUE (limit)', tick + ' must not consume the budget');
        }
        assert.strictEqual(ledger.topLevel, 1, 'only the parent spent the budget');
    });

});

describe('EMISSION_ISSUANCE_LIMITS budget in issue.js @regression @tier1', function () {
    beforeEach(freshIssue);
    afterEach(restoreStubs);

    it('a CARET tick is never exempt: it counts as top-level like batch.js says', async function () {
        // ^12 is an id reference, not a namespace child. batch.js refuses to exempt any
        // caret form and this must answer the same way, or the two rules disagree about
        // what a namespace registration is.
        const ledger = { topLevel: 1 };   // budget already spent
        const data   = issueData(ledger);

        await handler.parse(issueParams('^12'), data, null);

        assert.strictEqual(data.STATUS, 'invalid: ISSUE (limit)');
    });

    it('a caret-DOT tick is refused before the budget is even consulted', async function () {
        // '^1.2' classifies as top-level (its dot is a decimal), but the caret/parent rules
        // above reject it first, so the budget must come back UNSPENT: a name that never
        // reaches the counter must not cost the transaction its one slot.
        const ledger = { topLevel: 0 };
        const data   = issueData(ledger);

        await handler.parse(issueParams('^1.2'), data, null);

        assert.strictEqual(data.STATUS, 'invalid: TICK (parent unknown)');
        assert.strictEqual(ledger.topLevel, 0);
    });

    it('classification agrees with batch.js for every shape it has to decide', function () {
        assert.strictEqual(handler.isTopLevelIssuance('ALPHA'),   true);
        assert.strictEqual(handler.isTopLevelIssuance('ALPHA.1'), false);
        assert.strictEqual(handler.isTopLevelIssuance('A.B.C'),   false);
        assert.strictEqual(handler.isTopLevelIssuance('^12'),     true);
        assert.strictEqual(handler.isTopLevelIssuance('^1.2'),    true);
        // Exemption is granted on positive evidence only.
        assert.strictEqual(handler.isTopLevelIssuance(undefined), true);
        assert.strictEqual(handler.isTopLevelIssuance(null),      true);
        assert.strictEqual(handler.isTopLevelIssuance(''),        true);
    });

});

describe('EMISSION_ISSUANCE_LIMITS budget in issue.js @regression @tier1', function () {
    beforeEach(freshIssue);
    afterEach(restoreStubs);

    it('BELOW the flag nothing counts and nothing is refused (pre-flag identity)', async function () {
        gateOn = false;
        const ledger = { topLevel: 0 };

        for(const tick of ['ALPHA', 'BETA', 'GAMMA']){
            const data = issueData(ledger);
            await handler.parse(issueParams(tick), data, null);
            assert.strictEqual(data.STATUS, 'valid', tick);
        }
        assert.strictEqual(ledger.topLevel, 0, 'the counter must not move below the flag');
    });

    it('GENESIS is exempt: the bootstrap registers many names from one synthetic source', async function () {
        const ledger = { topLevel: 0 };

        for(const tick of ['ALPHA', 'BETA', 'GAMMA']){
            const data = issueData(ledger, { IS_GENESIS: true });
            await handler.parse(issueParams(tick), data, null);
            assert.notStrictEqual(data.STATUS, 'invalid: ISSUE (limit)', tick);
        }
        assert.strictEqual(ledger.topLevel, 0);
    });

    it('a context carrying no budget enforces nothing (inert, not fail-closed)', async function () {
        // Any caller that never came through a transaction or an injected-execution
        // context must behave exactly as it did before the flag.
        for(const tick of ['ALPHA', 'BETA']){
            const data = issueData(null);
            await handler.parse(issueParams(tick), data, null);
            assert.strictEqual(data.STATUS, 'valid', tick);
        }
    });

});
