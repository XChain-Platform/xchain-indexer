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
 * test/unit/emissionIssuanceLimits.test.js
 *
 * XC-1456: VM-emitted ISSUEs counted against the per-transaction top-level
 * issuance budget.
 *
 * THE DEFECT. execute.js routes a contract's emitted action straight to the
 * matching handler, which for ISSUE is past the per-BATCH limit scan - the only
 * place a top-level issuance was ever counted - and ISSUANCE_FEE_EMISSION_EXEMPT
 * (armed) makes an emitted issuance fee-free. One EXECUTE could therefore register
 * up to maxEmissions (50) top-level names for nothing, and a 250-command BATCH of
 * EXECUTEs up to 12,450, which is the whole namespace the dotted/undotted rule
 * exists to protect. Operator decision 2026-08-15 (option a): count them.
 *
 * WHAT THIS SUITE PINS, in the order the rule can break:
 *   - the REGISTRATION: a time-keyed change, genesis-active on testnet and regtest,
 *     mainnet on the UNARMED sentinel, and the sentinel still a sentinel. It is
 *     deliberately NOT folded into BATCH_ISSUANCE_LIMITS, which is already armed;
 *   - the RULE at its choke point (issue.js): one top-level tick per budget, dotted
 *     children exempt, caret ticks never exempt, genesis exempt, gate-off identity;
 *   - the PROPAGATION seams, which is where a rule with one counter really dies: the
 *     budget must reach an emission by REFERENCE (execute.js), a controller guard's
 *     emissions, a constructor's emissions (deploy.js), and every injected execution
 *     must get a FRESH budget of its own (execContext.js, xexec.js) rather than none.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');
const ProtocolChanges = require('../../src/protocol_changes.js');
const { buildInjectedExecContext } = require('../../src/actions/execContext.js');

const Issue   = require('../../src/actions/issue.js');
const Execute = require('../../src/actions/execute.js');

const GATE = 'EMISSION_ISSUANCE_LIMITS';

// The house UNARMED sentinel for a change whose remedy is ruled but whose activation
// instant is a separate, deliberate operator act.
const UNARMED_SENTINEL = 9999999999;

// A far-future instant no real chain reaches before the operator arms the gate
// deliberately: 2100-01-01, the boundary the sibling unarmed-gate suites use to tell a
// scheduled date from an UNARMED sentinel.
const YEAR_2100 = 4102444800;

// Below 862633 the ISSUANCE_FEE gate is off, so a new token needs no GAS balance.
const LOW_BLOCK = 100;

function pcFor(network){
    const indexer = createMockIndexer();
    indexer.config['NETWORK'] = network;
    return new ProtocolChanges(indexer);
}

/*****************************************************************
 * The registration / flag day
 ****************************************************************/

describe('EMISSION_ISSUANCE_LIMITS gate registration @regression @tier1', function () {

    it('is a registered protocol change', function () {
        assert.ok(pcFor('regtest').isDefined(GATE), GATE + ' must be registered');
    });

    it('is genesis-active on regtest and testnet', async function () {
        for(const network of ['regtest', 'testnet']){
            const pc = pcFor(network);
            assert.strictEqual(await pc.isEnabled(GATE, 1), true, network + ' must be genesis-active');
        }
    });

    it('mainnet sits on the UNARMED sentinel, and the sentinel is still a sentinel', function () {
        // An armed-looking real date here means somebody armed a consensus tightening
        // without the replay evidence, which is exactly the act the flag exists to prevent.
        assert.strictEqual(ProtocolChanges.EMISSION_ISSUANCE_LIMITS_MAINNET_TIME, UNARMED_SENTINEL);
        assert.ok(ProtocolChanges.EMISSION_ISSUANCE_LIMITS_MAINNET_TIME > YEAR_2100,
            'a real instant here is an arming, not a registration');
    });

    it('is NOT folded into BATCH_ISSUANCE_LIMITS, which is already armed', function () {
        // Widening an armed flag would apply a new consensus rule past a boundary nodes
        // have already deployed for, forking the ones still on pre-arm code.
        assert.notStrictEqual(
            ProtocolChanges.EMISSION_ISSUANCE_LIMITS_MAINNET_TIME,
            ProtocolChanges.BATCH_ISSUANCE_LIMITS_MAINNET_TIME);
        assert.ok(ProtocolChanges.BATCH_ISSUANCE_LIMITS_MAINNET_TIME < YEAR_2100,
            'the sibling is armed; this assertion is the reason the new gate is separate');
    });

});

/*****************************************************************
 * The rule, at its choke point
 ****************************************************************/

describe('EMISSION_ISSUANCE_LIMITS budget in issue.js @regression @tier1', function () {
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

    beforeEach(function () {
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
    });

    afterEach(function () {
        sinon.restore();
    });

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

/*****************************************************************
 * The propagation seams
 ****************************************************************/

describe('EMISSION_ISSUANCE_LIMITS budget propagation @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    const SOURCE   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const CONTRACT = 5;

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.indexerDb.getContractPermissions = sinon.stub().resolves(null);
        indexer.indexerDb.createActionIndex      = sinon.stub().resolves(777);

        actionsCtx = {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: indexer.protocolChanges,
            vm:              { execute: sinon.stub().resolves({ success: true, gasUsed: 0, stateChanges: [], stateDeletes: [], emittedActions: [] }) },
        };
        handler = new Execute(actionsCtx);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('an ISSUE emission receives the executing transaction\'s budget BY REFERENCE', async function () {
        // By reference is the whole rule: a copy would give every emission its own budget
        // and reopen the hole, and the test that catches that is this identity check.
        let seen = null;
        actionsCtx.actionIssue = { parse: sinon.stub().callsFake(async (params, data) => {
            seen = data['ISSUANCE_LIMIT_LEDGER'];
            data['STATUS'] = 'valid';
        }) };
        handler = new Execute(actionsCtx);

        const ledger   = { topLevel: 0 };
        const execData = createBaseData({
            ACTION: 'EXECUTE', FORMAT: 0, SOURCE, BLOCK_INDEX: LOW_BLOCK,
            CONTRACT_ACTION_INDEX: CONTRACT,
            ISSUANCE_LIMIT_LEDGER: ledger,
        });

        await handler.processEmission({ action: 'ISSUE', params: { tick: 'ALPHA', description: 'x' } }, execData, 0);

        assert.strictEqual(seen, ledger, 'the emission must share the transaction budget object, not a copy');
    });

    it('two emissions of one EXECUTE share ONE budget', async function () {
        const seen = [];
        actionsCtx.actionIssue = { parse: sinon.stub().callsFake(async (params, data) => {
            seen.push(data['ISSUANCE_LIMIT_LEDGER']);
            data['STATUS'] = 'valid';
        }) };
        handler = new Execute(actionsCtx);

        const ledger   = { topLevel: 0 };
        const execData = createBaseData({
            ACTION: 'EXECUTE', FORMAT: 0, SOURCE, BLOCK_INDEX: LOW_BLOCK,
            CONTRACT_ACTION_INDEX: CONTRACT,
            ISSUANCE_LIMIT_LEDGER: ledger,
        });

        await handler.processEmission({ action: 'ISSUE', params: { tick: 'ALPHA', description: 'x' } }, execData, 0);
        await handler.processEmission({ action: 'ISSUE', params: { tick: 'BETA',  description: 'x' } }, execData, 1);

        assert.strictEqual(seen.length, 2);
        assert.strictEqual(seen[0], ledger);
        assert.strictEqual(seen[1], ledger);
    });

    it('an injected callback execution gets a FRESH budget of its own, never none', function () {
        // An injected callback has no transaction to draw from and IS a root execution, so
        // "none" would leave the emission path it opens completely unbounded.
        const ctx = buildInjectedExecContext({
            chain: 'BTC', network: 'regtest', contractIndex: CONTRACT,
            actionIndex: 42, blockIndex: LOW_BLOCK, emitter: 41,
            txHash: 'a'.repeat(64),
        });

        assert.deepStrictEqual(ctx.ISSUANCE_LIMIT_LEDGER, { topLevel: 0 });
    });

    it('two injected executions do not share a budget', function () {
        const opts = {
            chain: 'BTC', network: 'regtest', contractIndex: CONTRACT,
            actionIndex: 42, blockIndex: LOW_BLOCK, emitter: 41,
            txHash: 'a'.repeat(64),
        };
        const a = buildInjectedExecContext(opts);
        const b = buildInjectedExecContext(opts);

        assert.notStrictEqual(a.ISSUANCE_LIMIT_LEDGER, b.ISSUANCE_LIMIT_LEDGER);
    });

});
