// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// BATCH R4 aggregate gas pre-check: when a no-gas issuance batch collapses to one
// invalid record. Part of the Batch suite; see ../batch.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const { SOURCE, useBatchHarness } = require('./helpers/batch_harness.js');

const Batch = require('../../../../../src/actions/batch/index.js');

// The harness under test. useBatchHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, handler;
const bind = (h) => { ({ indexer, actionsCtx, handler } = h); };

const ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

// Nominal new-tick issuance fees under the BTC regtest gas schedule:
// ISSUE 100000 gas and ISSUE_SUBTOKEN 50000 gas, both at GAS_PRICE 0.00001 XCHAIN.
// Written out rather than recomputed so a schedule change reddens these tests instead
// of silently re-deriving whatever the code now believes.
const TOP_FEE   = '1.00000000';
const CHILD_FEE = '0.50000000';

// Per-name gate. Sub-action normalization is ON throughout; ISSUANCE_FEE and
// UNIFIED_FEES are ON because those are the activations under which an ISSUE has a
// knowable nominal price at all. `limitsOn` is the only variable, so every OFF run
// below pins the pre-flag verdict for the identical input.
function stubGates(limitsOn) {
    const known = ['BATCH', 'SEND', 'ISSUE', 'MINT', 'ISSUANCE_FEE', 'UNIFIED_FEES'];
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
        if (name === 'BATCH_SUBACTION_NORMALIZATION') return true;
        if (name === 'BATCH_ISSUANCE_LIMITS') return limitsOn;
        return known.includes(name);
    });
    handler = new Batch(actionsCtx);
}

// n distinct child issuances under one parent: the spam shape the collapse rule targets.
function children(n) {
    const out = [];
    for (let i = 1; i <= n; i++) out.push('ISSUE|0|JDOG.' + i);
    return out;
}

// `balance` is the SOURCE's XCHAIN holding, keyed by the mock getTickerId's fixed id 1.
async function run(limitsOn, commands, balance) {
    stubGates(limitsOn);
    const data = createBaseData({
        ACTION:  'BATCH',
        FORMAT:  0,
        SOURCE,
        TX_DATA: 'BATCH|0|' + commands.join(';'),
    });
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getAddressBalances.resolves(balance === null ? {} : { 1: balance });
    await handler.parse(['0'], data, null);
    return data;
}

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('R4 aggregate gas pre-check (BATCH_ISSUANCE_LIMITS)', function () {
        it('gate ON: a batch the source can afford proceeds and every sub-command still bills itself', async function () {
            // One parent (1.0) plus three children (0.5 each) = 2.5 nominal, exactly covered.
            const data = await run(true, ['ISSUE|0|JDOG'].concat(children(3)), '2.50000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 4, 'all four sub-commands dispatched');
            assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 4, 'each still gets its own ACTION_INDEX');
            // The pre-check reads the budget once and bills nobody: per-command billing stays
            // in the handlers, which re-read balances as of their own ACTION_INDEX.
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 1, 'one read, no per-command billing here');
        });

        it('gate ON: a batch the source provably cannot afford is ONE invalid record, no sub-command runs', async function () {
            const data = await run(true, children(250), '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: GAS (insufficient)');
            assert.strictEqual(actionsCtx.processAction.callCount, 0);
            assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1, 'one whole-batch record, not 250 invalid rows');
            assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0);
        });

        it('gate ON: the 250-command cap error still wins when both apply', async function () {
            const data = await run(true, children(251), '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            assert.ok(!String(data['STATUS']).includes('GAS'), 'cap error is distinguishable from the gas error');
        });

        it('gate ON: exactly the cheapest sub-command\'s worth is accepted (boundary)', async function () {
            const data = await run(true, children(3), CHILD_FEE);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 3, 'the handlers decide which of the three can pay');
        });

        it('gate ON: one satoshi under the cheapest sub-command is rejected (no off-by-one)', async function () {
            const data = await run(true, children(3), '0.49999999');

            assert.strictEqual(data['STATUS'], 'invalid: GAS (insufficient)');
        });

        it('gate ON: the cheapest sub-command sets the bar, not the sum', async function () {
            // A parent plus one child needs 1.5 in total but only 0.5 to land the cheaper of
            // the two. A sum-based predicate would reject this batch and destroy work that
            // really would have succeeded; the rule (K affordable => K valid) is the
            // same invariant stated on-chain.
            const data = await run(true, ['ISSUE|0|JDOG', 'ISSUE|0|JDOG.1'], CHILD_FEE);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 2);
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('R4 aggregate gas pre-check (BATCH_ISSUANCE_LIMITS)', function () {
        it('gate ON: a single undotted ISSUE is judged at the top-level price, not the child price', async function () {
            const belowTop = '0.99999999';
            const data = await run(true, ['ISSUE|0|JDOG'], belowTop);

            assert.strictEqual(data['STATUS'], 'invalid: GAS (insufficient)');

            const funded = await run(true, ['ISSUE|0|JDOG'], TOP_FEE);
            assert.strictEqual(funded['STATUS'], 'valid');
        });

        it('gate ON: one non-ISSUE sub-command exempts the whole batch (cost not knowable here)', async function () {
            // SEND's fee is db_hits-derived inside its own handler, so the batch has no
            // provable floor and must proceed even on a zero balance.
            const data = await run(true, children(3).concat(['SEND|0|TEST|1|' + ADDR]), '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 4);
        });

        it('gate ON: an existing TICK is a FREE re-issue, so the batch proceeds on a zero balance', async function () {
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'JDOG.1' }));

            const data = await run(true, children(3), '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 3);
        });

        it('gate ON: caret TICKs carry no provable price, so they never trigger the reject', async function () {
            const data = await run(true, ['ISSUE|0|^12'], '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('gate ON: the GAS tick is fee-exempt, so its issuance never triggers the reject', async function () {
            const data = await run(true, ['ISSUE|0|' + indexer.config['GAS']], '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('R4 aggregate gas pre-check (BATCH_ISSUANCE_LIMITS)', function () {
        it('gate ON: native-coin fee mode is out of scope (the fee never touches this balance)', async function () {
            stubGates(true);
            const data = createBaseData({
                ACTION:     'BATCH',
                FORMAT:     0,
                SOURCE,
                TX_DATA:    'BATCH|0|' + children(3).join(';'),
                TX_OUTPUTS: [{ address: indexer.config['ADDRESS']['FEE_DESTINATION'], value: '0.001' }],
            });
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressBalances.resolves({});

            await handler.parse(['0'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0, 'no gas read at all in native mode');
        });

        it('gate ON: ISSUANCE_FEE inactive means no fee to be short of', async function () {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
                if (name === 'ISSUANCE_FEE') return false;
                if (name === 'UNKNOWNACTION') return false;
                return true;
            });
            handler = new Batch(actionsCtx);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|' + children(3).join(';'),
            });
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressBalances.resolves({});

            await handler.parse(['0'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('gate ON: the TICK probe never interns, and restores the suppression flag', async function () {
            const seen = [];
            indexer.indexerDb.suppressIndexIdCreation = false;
            indexer.indexerDb.getTokenInfo.callsFake(async () => {
                seen.push(indexer.indexerDb.suppressIndexIdCreation);
                return null;
            });

            await run(true, children(2), '5.00000000');

            assert.deepStrictEqual(seen, [true, true], 'every probe ran resolve-only');
            assert.strictEqual(indexer.indexerDb.suppressIndexIdCreation, false, 'prior value restored');
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('R4 aggregate gas pre-check (BATCH_ISSUANCE_LIMITS)', function () {
        it('gate ON: a repeated TICK costs one probe, and repeats do not become free', async function () {
            const data = await run(true, ['ISSUE|0|JDOG.1', 'ISSUE|0|JDOG.1', 'ISSUE|0|JDOG.1'], '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: GAS (insufficient)');
            assert.strictEqual(indexer.indexerDb.getTokenInfo.callCount, 1, 'memoized per TICK');
        });

        it('gate ON: an earlier verdict short-circuits the check before it reads anything', async function () {
            const data = await run(true, ['ISSUE|0|JDOG', 'ISSUE|0|OTHER'], '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0, 'no gas read on an already-invalid batch');
            assert.strictEqual(indexer.indexerDb.getTokenInfo.callCount, 0, 'no TICK probes either');
        });

        it('gate OFF: the 250-child no-gas batch keeps the pre-flag verdict', async function () {
            const data = await run(false, children(250), '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
        });

        it('gate OFF: a lone unaffordable child ISSUE stays valid (pre-flag verdict)', async function () {
            const data = await run(false, ['ISSUE|0|JDOG.1'], '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 1);
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0, 'the pre-check does not run below the flag');
        });

        it('gate OFF: the one-satoshi-under batch keeps the pre-flag verdict', async function () {
            const data = await run(false, children(3), '0.49999999');

            assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
        });

        it('gate OFF: the affordable parent-plus-children batch keeps the pre-flag reject', async function () {
            const data = await run(false, ['ISSUE|0|JDOG'].concat(children(3)), '2.50000000');

            assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
        });

        it('gate OFF: 251 children report the ISSUE limit, not the cap and not gas', async function () {
            const data = await run(false, children(251), '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
        });
    });
});
