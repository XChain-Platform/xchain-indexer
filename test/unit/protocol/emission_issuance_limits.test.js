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
 * test/unit/protocol/emission_issuance_limits.test.js
 *
 * VM-emitted ISSUEs counted against the per-transaction top-level
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
 *   - the REGISTRATION: a time-keyed change, genesis-active on EVERY network.
 *     Mainnet was armed at 0 by the 2026-09-09 ruling, on the measurement that it
 *     holds zero EXECUTEs and zero contracts, so there is no emission for the budget
 *     to count. It stays a SEPARATE entry from BATCH_ISSUANCE_LIMITS, which is armed
 *     at a real mainnet instant and may never be edited to carry a second rule;
 *   - the RULE at its choke point (issue.js): one top-level tick per budget, dotted
 *     children exempt, caret ticks never exempt, genesis exempt, gate-off identity;
 *   - the PROPAGATION seams, which is where a rule with one counter really dies: the
 *     budget must reach an emission by REFERENCE (execute.js), a controller guard's
 *     emissions, a constructor's emissions (deploy.js), and every injected execution
 *     must get a FRESH budget of its own (execContext.js, xexec.js) rather than none.
 *
 * This file holds the registration and the propagation seams; the rule at its
 * choke point lives beside it in emission_issuance_limits.test/, opening the
 * same describe title so every full test title is unchanged, over the gate name
 * and block height in emission_issuance_limits.test/helpers/.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const ProtocolChanges = require('../../../src/protocol_changes.js');
const { buildInjectedExecContext } = require('../../../src/consensus/exec_context.js');
const { GATE, LOW_BLOCK } = require('./emission_issuance_limits.test/helpers/emission_budget_fixtures.js');

const Execute = require('../../../src/actions/execute/index.js');

// The house UNARMED sentinel for a change whose remedy is ruled but whose activation
// instant is a separate, deliberate operator act.
const UNARMED_SENTINEL = 9999999999;

// A far-future instant no real chain reaches before the operator arms the gate
// deliberately: 2100-01-01, the boundary the sibling unarmed-gate suites use to tell a
// scheduled date from an UNARMED sentinel.
const YEAR_2100 = 4102444800;

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

    it('is genesis-active on every network, mainnet included', async function () {
        for(const network of ['regtest', 'testnet', 'mainnet']){
            const pc = pcFor(network);
            assert.strictEqual(await pc.isEnabled(GATE, 1), true, network + ' must be genesis-active');
        }
    });

    it('mainnet is armed at exactly 0, the 2026-09-09 genesis arm', function () {
        // 0 means "the budget always applied", which a from-genesis replay reproduces
        // because mainnet has no EXECUTE to emit an ISSUE in the first place. Any other
        // past value would be a tightening at an instant the fleet never observed, and a
        // future value would be a flag day the measurement says nothing needs.
        assert.strictEqual(ProtocolChanges.EMISSION_ISSUANCE_LIMITS_MAINNET_TIME, 0);
        assert.notStrictEqual(ProtocolChanges.EMISSION_ISSUANCE_LIMITS_MAINNET_TIME, UNARMED_SENTINEL);
        assert.ok(ProtocolChanges.EMISSION_ISSUANCE_LIMITS_MAINNET_TIME < YEAR_2100,
            'a far-future value here reads as an unarmed sentinel');
    });

    it('is still its OWN entry, never folded into the armed BATCH_ISSUANCE_LIMITS', function () {
        // The two now differ in the other direction (0 against a real mainnet instant),
        // but the reason for two entries is unchanged: editing an armed instant would
        // apply a new consensus rule past a boundary nodes already deployed for.
        assert.notStrictEqual(
            ProtocolChanges.EMISSION_ISSUANCE_LIMITS_MAINNET_TIME,
            ProtocolChanges.BATCH_ISSUANCE_LIMITS_MAINNET_TIME);
        assert.ok(ProtocolChanges.BATCH_ISSUANCE_LIMITS_MAINNET_TIME > 0,
            'the sibling keeps its armed instant; that is why this gate is a separate entry');
        assert.ok(ProtocolChanges.BATCH_ISSUANCE_LIMITS_MAINNET_TIME < YEAR_2100);
    });

});

let indexer, actionsCtx, handler;

const SOURCE   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const CONTRACT = 5;

/*****************************************************************
 * The propagation seams
 ****************************************************************/

describe('EMISSION_ISSUANCE_LIMITS budget propagation @regression @tier2', function () {
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
});

describe('EMISSION_ISSUANCE_LIMITS budget propagation @regression @tier2', function () {
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
});

describe('EMISSION_ISSUANCE_LIMITS budget propagation @regression @tier2', function () {
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
