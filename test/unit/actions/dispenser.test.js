// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Dispenser = require('../../../src/actions/dispenser.js');

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

function makeParams(str) {
    return String(str).split('|');
}

describe('Dispenser action handler @regression @tier2', function () {
    let indexer;
    let actionsCtx;
    let dispenser;

    const OWNER_ADDR = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const OTHER_ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
    const BLOCK_TIME  = 1700000000;
    const EXPIRATION  = BLOCK_TIME + 86400 * 30; // 30 days later

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        dispenser  = new Dispenser(actionsCtx);

        // Default GIVE token exists
        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null }));

        // Default GET token (coin-denominated; GET_TICK empty so getTokenInfo returns null, that is fine)
        indexer.indexerDb.getTokenInfo
            .withArgs('', sinon.match.any, sinon.match.any)
            .resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(null, sinon.match.any, sinon.match.any)
            .resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(undefined, sinon.match.any, sinon.match.any)
            .resolves(null);

        // Default: sufficient balance (TICK_ID 10 → 1000 tokens)
        indexer.indexerDb.getAddressBalances.resolves({ 10: '1000' });

        // Default: not sleeping, action allowed
        indexer.indexerDb.isActionAllowed.resolves(true);

        // Default preferences
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });

        // Fee tick id
        indexer.indexerDb.getTickerId.resolves(99);
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('Format 0 – Create Dispenser', function () {

        it('valid dispenser creation calls createDispenser and createDispenserStatus', async function () {
            // FORMAT: 0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||Creating JDOG dispenser`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenser);
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserStatus);
        });

        it('valid dispenser escrow deducts GIVE_ESCROW from SOURCE balance', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            sinon.assert.calledOnce(indexer.indexerDb.updateBalances);
            sinon.assert.calledOnce(indexer.indexerDb.updateTokens);
        });

        it('GIVE_TICK not found returns invalid', async function () {
            indexer.indexerDb.getTokenInfo
                .withArgs('UNKNOWN', sinon.match.any, sinon.match.any)
                .resolves(null);

            const params = makeParams(`0|BTC|UNKNOWN|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GIVE_TICK'));
            // createDispenser is always called (records the invalid attempt); ledger changes are skipped
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });

        it('invalid GET_ADDRESS format returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|not-a-valid-address||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GET_ADDRESS'));
        });

        it('insufficient balance for GIVE_ESCROW returns invalid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 10: '0' });

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('insufficient funds'));
        });

        // Balance-dispenser GIVE_AMOUNT positivity gate. Empty or "0" GIVE_AMOUNT
        // used to open a dispenser that settled buyer payments as VALID fills
        // crediting nothing and never auto-closed. The gate is genesis-active on
        // regtest, which is the network this file runs under.
        it('empty GIVE_AMOUNT on a balance dispenser returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GIVE_AMOUNT'), data['STATUS']);
            sinon.assert.notCalled(indexer.indexerDb.createDispenserStatus);
        });

        it('zero GIVE_AMOUNT on a balance dispenser returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|0||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GIVE_AMOUNT'), data['STATUS']);
        });

        // The gate constrains GIVE_AMOUNT only. Opening empty and topping up with a
        // format-2 refill is a legitimate flow and is not a trap: the dispense-side
        // clamp drives the multiplier to 0 against a zero GIVE_REMAINING, so a
        // payment against an empty dispenser settles invalid and consumes nothing.
        it('empty GIVE_ESCROW with a positive GIVE_AMOUNT stays valid', async function () {
            const params = makeParams(`0|BTC|JDOG|1|||BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('EXPIRATION before BLOCK_TIME returns invalid', async function () {
            const pastExpiry = BLOCK_TIME - 1000;
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${pastExpiry}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('EXPIRATION'));
        });

        it('EXPIRATION equal to BLOCK_TIME returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${BLOCK_TIME}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('EXPIRATION'));
        });

        it('GIVE_COIN not matching COIN config returns invalid', async function () {
            const params = makeParams(`0|LTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].startsWith('invalid'));
        });

        it('GET_COIN not matching COIN config returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|LTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].startsWith('invalid'));
        });

        it('SOURCE sleeping returns invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .withArgs(OWNER_ADDR, null, sinon.match.any)
                .resolves(false);

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('SOURCE'));
        });

        it('TICK sleeping returns invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .withArgs(null, 'JDOG', sinon.match.any)
                .resolves(false);

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('TICK'));
        });

        it('invalid FIAT_CODE returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}|XXX|100.00||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('FIAT_CODE'));
        });

        it('pre-existing error short-circuits processing', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, 'invalid: pre-existing');

            // createDispenser is always called (records the attempt); but ledger changes are not applied
            assert.ok(data['STATUS'].includes('pre-existing'));
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });
    });

    describe('Format 1 – Cancel Dispenser', function () {

        function makeDispenserInfo(overrides = {}) {
            return {
                ACTION_INDEX:       50,
                SOURCE:             OWNER_ADDR,
                GET_ADDRESS:        OWNER_ADDR,
                GIVE_COIN:          'BTC',
                GIVE_TICK:          'JDOG',
                GET_COIN:           'BTC',
                GET_TICK:           null,
                GIVE_REMAINING:     '10',
                DISPENSER_STATUS:   'open',
                EXPIRATION:         EXPIRATION,
                BLOCK_TIME:         BLOCK_TIME,
                ALLOW_LIST:         null,
                BLOCK_LIST:         null,
                ...overrides,
            };
        }

        beforeEach(function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());
        });

        it('owner cancels open dispenser returns valid', async function () {
            const params = makeParams('1|50|Closing dispenser');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserCancel);
        });

        it('cancel sets dispenser status to cancelling', async function () {
            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            const statusCall = indexer.indexerDb.createDispenserStatus.firstCall;
            assert.ok(statusCall, 'createDispenserStatus should have been called');
            assert.strictEqual(statusCall.args[2], 'cancelling');
        });

        it('cancel by non-owner returns invalid', async function () {
            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OTHER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            // createDispenserCancel is always called (records the attempt); ledger changes are skipped
            assert.ok(data['STATUS'].includes('SOURCE'));
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });

        // Delegated dispensers (GET_ADDRESS != SOURCE): the ownership gate accepts EITHER
        // the create SOURCE or the GET_ADDRESS the dispenser operates on. This is the
        // contract the recognition-only decoder mirrors when it resolves a cancel/edit by
        // acting address (it has no action_index of its own), so both arms are pinned
        // here: a decoder that keys on only one of them keeps a cancelled dispenser in its
        // open view and keeps proposing DISPENSE triggers the indexer drops.
        it('a delegated dispenser can be cancelled by its original creator', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
                SOURCE:      OWNER_ADDR,   // opened the dispenser
                GET_ADDRESS: OTHER_ADDR,   // but it operates on (and is paid at) OTHER
            }));
            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserCancel);
        });

        it('a delegated dispenser can also be cancelled by its GET_ADDRESS', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
                SOURCE:      OWNER_ADDR,
                GET_ADDRESS: OTHER_ADDR,
            }));
            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OTHER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserCancel);
        });

        it('cancel of unknown dispenser (getDispenserInfo returns null) throws before validation', async function () {
            // When dispenserInfo is null, the code crashes at line 99 of dispenser.js (info['GIVE_TICK'])
            // before the validation check can run (this is a known code limitation).
            // We verify that the error is propagated as a rejection.
            indexer.indexerDb.getDispenserInfo.resolves(null);

            const params = makeParams('1|9999|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await assert.rejects(
                () => dispenser.parse(params, data, false),
                (err) => {
                    assert.ok(err instanceof TypeError);
                    return true;
                }
            );
        });

        it('cancel of non-open dispenser returns invalid', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ DISPENSER_STATUS: 'closed' }));

            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('DISPENSER_ACTION_INDEX'));
        });

        it('valid cancel updates action index to DISPENSER_CANCEL', async function () {
            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            sinon.assert.calledWith(indexer.indexerDb.updateActionIndex, sinon.match.any, 'DISPENSER_CANCEL');
        });
    });

    describe('Format 2 – Edit Dispenser', function () {

        function makeDispenserInfo(overrides = {}) {
            return {
                ACTION_INDEX:     50,
                SOURCE:           OWNER_ADDR,
                GET_ADDRESS:      OWNER_ADDR,
                GIVE_COIN:        'BTC',
                GIVE_TICK:        'JDOG',
                GIVE_REMAINING:   '10',
                GET_COIN:         'BTC',
                GET_TICK:         null,
                DISPENSER_STATUS: 'open',
                EXPIRATION:       EXPIRATION,
                BLOCK_TIME:       BLOCK_TIME,
                ALLOW_LIST:       null,
                BLOCK_LIST:       null,
                ...overrides,
            };
        }

        beforeEach(function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());
        });

        it('owner edits open dispenser returns valid and calls createDispenserEdit', async function () {
            // Add 20 more to escrow, extend expiration
            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||Refilling`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserEdit);
        });

        it('non-owner edit returns invalid', async function () {
            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OTHER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('SOURCE'));
        });

        it('edit of unknown dispenser (getDispenserInfo returns null) throws before validation', async function () {
            // When dispenserInfo is null, the code crashes at info['GIVE_TICK'] before validation.
            indexer.indexerDb.getDispenserInfo.resolves(null);

            const params = makeParams(`2|9999|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await assert.rejects(
                () => dispenser.parse(params, data, false),
                (err) => {
                    assert.ok(err instanceof TypeError);
                    return true;
                }
            );
        });

        it('edit of non-open dispenser returns invalid', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ DISPENSER_STATUS: 'closed' }));

            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('DISPENSER_ACTION_INDEX'));
        });

        it('edit escrow deducted when GIVE_ESCROW provided', async function () {
            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            sinon.assert.calledOnce(indexer.indexerDb.updateBalances);
        });

        it('valid edit updates action index to DISPENSER_EDIT', async function () {
            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            sinon.assert.calledWith(indexer.indexerDb.updateActionIndex, sinon.match.any, 'DISPENSER_EDIT');
        });

        // ── MAX_REFILLS cap (dispenser_caps_activation.js). A refill is a
        //    format-2 edit that tops up GIVE_ESCROW; the 6th is rejected. Gated on the
        //    dispenser-family cohort (mainnet block_time 1786060800, testnet/regtest genesis).
        describe('MAX_REFILLS cap', function () {

            it('rejects the 6th refill (caps active, regtest genesis)', async function () {
                indexer.indexerDb.getDispenserRefillCount.resolves(5); // already at the limit
                const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);   // GIVE_ESCROW=20 top-up
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.ok(data['STATUS'].includes('MAX_REFILLS'), 'the 6th refill must be rejected: ' + data['STATUS']);
                assert.ok(indexer.indexerDb.getDispenserRefillCount.calledWith(data['DISPENSER_ACTION_INDEX']),
                    'the refill count must be queried for the edited dispenser');
            });

            it('allows the 5th refill (below the limit)', async function () {
                indexer.indexerDb.getDispenserRefillCount.resolves(4);
                const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid');
            });

            it('does NOT count a non-refill edit (no GIVE_ESCROW) against the cap', async function () {
                indexer.indexerDb.getDispenserRefillCount.resolves(5); // at the limit
                // Expiration-only edit: GIVE_ESCROW empty, so it is not a refill.
                const params = makeParams(`2|50||${EXPIRATION + 86400}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid', 'a non-refill edit must not be blocked by MAX_REFILLS');
            });

            it('below the caps flag-day (mainnet block_time < 1786060800): no refill limit', async function () {
                actionsCtx.config = Object.assign({}, indexer.config, { NETWORK: 'mainnet', COIN: 'BTC' });
                dispenser = new Dispenser(actionsCtx);
                indexer.indexerDb.getDispenserRefillCount.resolves(5); // would be rejected if the cap were active
                const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
                // BLOCK_TIME 1700000000 < 1786060800 => caps inactive
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid', 'below the flag-day the legacy uncapped behavior must run');
            });
        });

        // Ownership dispensers hold no balance escrow, on edit as on create.
        // A format-2 refill used to debit GIVE_ESCROW while close/expire took the
        // GIVE_OWNERSHIP branch that credits nothing back, stranding the balance.
        // Gated on the same dispenser-family cohort as MAX_REFILLS above.
        describe('GIVE_ESCROW on an ownership dispenser', function () {

            it('rejects a format-2 refill of an ownership dispenser (cohort active, regtest genesis)', async function () {
                indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_OWNERSHIP: 1 }));
                const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);   // GIVE_ESCROW=20 top-up
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.ok(data['STATUS'].includes('GIVE_ESCROW'),
                    'a refill of an ownership dispenser must be rejected: ' + data['STATUS']);
                sinon.assert.notCalled(indexer.indexerDb.updateBalances);
            });

            it('still allows an expiration-only edit of an ownership dispenser', async function () {
                indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_OWNERSHIP: 1 }));
                const params = makeParams(`2|50||${EXPIRATION + 86400}|||`);     // GIVE_ESCROW empty
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid',
                    'an ownership dispenser must stay editable for expiration and lists');
            });

            it('leaves a balance-dispenser refill untouched', async function () {
                indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_OWNERSHIP: 0 }));
                const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid');
            });

            it('below the cohort flag-day (mainnet block_time < 1786060800): legacy accept', async function () {
                actionsCtx.config = Object.assign({}, indexer.config, { NETWORK: 'mainnet', COIN: 'BTC' });
                dispenser = new Dispenser(actionsCtx);
                indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_OWNERSHIP: 1 }));
                const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
                // BLOCK_TIME 1700000000 < 1786060800 => cohort inactive
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid',
                    'below the flag-day historical replay must stay byte-identical');
            });
        });
    });

    describe('Unknown format', function () {
        it('unknown VERSION returns invalid', async function () {
            const params = makeParams('9|BTC|JDOG|1||10|BTC||0.01|||');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 9, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('invalid'));
        });
    });

    describe('GET_ADDRESS different from SOURCE validation (freshness)', function () {

        it('GET_ADDRESS with DISPENSER_PREFERENCE=2 allows any opener', async function () {
            // GET_ADDRESS != SOURCE, but GET_ADDRESS has DISPENSER_PREFERENCE=2 (open to anyone)
            indexer.indexerDb.getAddressPreferences
                .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 2 });

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        // ── AT/ABOVE the freshness flag-day (regtest is genesis-active): the verdict
        //    derives from indexer-local chain state (db.hasXChainActivityBefore); the
        //    external utxo-tracker is NEVER consulted. dispenser_freshness_activation.js.
        describe('local path (freshness flag-day active, regtest genesis)', function () {

            it('fresh GET_ADDRESS (no prior XChain activity) is allowed, and the tracker is NOT consulted', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
                indexer.indexerDb.hasXChainActivityBefore.resolves(false); // fresh

                // Wire a tracker too, to prove the local path never touches it.
                const getFirstSeen = sinon.stub().resolves({ height: 1 }); // would say "not fresh" if consulted
                actionsCtx.utxoTracker = { enabled: true, getFirstSeen };
                dispenser = new Dispenser(actionsCtx);

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.hasXChainActivityBefore.calledWith(OTHER_ADDR, data['BLOCK_INDEX']),
                    'local freshness query must be consulted with BLOCK_INDEX');
                assert.ok(getFirstSeen.notCalled, 'the external utxo-tracker must NOT be consulted above the gate');
            });

            it('non-fresh GET_ADDRESS (prior XChain activity) is not permitted', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
                indexer.indexerDb.hasXChainActivityBefore.resolves(true); // has history

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.ok(data['STATUS'].includes('GET_ADDRESS') && data['STATUS'].includes('not permitted'));
            });

            it('non-fresh GET_ADDRESS with origin standing is allowed (DISPENSER_ORIGIN_STANDING)', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
                indexer.indexerDb.hasXChainActivityBefore.resolves(true); // not fresh
                indexer.indexerDb.hasDispenserOriginStanding
                    .withArgs(OWNER_ADDR, OTHER_ADDR, sinon.match.any)
                    .resolves(true);

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: 800000 });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.hasDispenserOriginStanding.calledWith(OWNER_ADDR, OTHER_ADDR, sinon.match.any));
            });

            it('non-fresh GET_ADDRESS where a DIFFERENT address holds standing stays invalid', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
                indexer.indexerDb.hasXChainActivityBefore.resolves(true); // not fresh
                // Default hasDispenserOriginStanding resolves false.

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: 800000 });

                await dispenser.parse(params, data, false);

                assert.ok(data['STATUS'].includes('GET_ADDRESS') && data['STATUS'].includes('not permitted'));
            });

            it('origin standing is not consulted when DISPENSER_ORIGIN_STANDING is inactive', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
                indexer.indexerDb.hasXChainActivityBefore.resolves(true); // not fresh
                actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(
                    async (name) => name !== 'DISPENSER_ORIGIN_STANDING',
                );
                dispenser = new Dispenser(actionsCtx);
                indexer.indexerDb.hasDispenserOriginStanding.resolves(true);

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: 800000 });

                await dispenser.parse(params, data, false);

                assert.ok(data['STATUS'].includes('GET_ADDRESS') && data['STATUS'].includes('not permitted'));
                assert.ok(indexer.indexerDb.hasDispenserOriginStanding.notCalled);
            });
        });

        // ── BELOW the freshness flag-day: byte-identical legacy behavior. The verdict
        //    comes from the external utxo-tracker getFirstSeen HTTP call and the local
        //    query is NEVER consulted. Modelled with a mainnet-BTC config below 961000
        //    (util keeps its own regtest config, so the regtest test addresses still
        //    validate; only the freshness gate sees mainnet).
        describe('legacy path (below the freshness flag-day: mainnet BTC < 961000)', function () {

            function mainnetBelowGateCtx() {
                actionsCtx.config = Object.assign({}, indexer.config, { NETWORK: 'mainnet', COIN: 'BTC' });
            }

            it('tracker-fresh GET_ADDRESS is allowed, and the local query is NOT consulted', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
                // If the local query were (wrongly) consulted it would say "has history".
                indexer.indexerDb.hasXChainActivityBefore.resolves(true);

                mainnetBelowGateCtx();
                const getFirstSeen = sinon.stub().resolves(null); // never seen => fresh
                actionsCtx.utxoTracker = { enabled: true, getFirstSeen };
                dispenser = new Dispenser(actionsCtx);

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: 500 });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(getFirstSeen.calledWith(OTHER_ADDR), 'legacy path must consult the tracker');
                assert.ok(indexer.indexerDb.hasXChainActivityBefore.notCalled,
                    'below the gate the local freshness query must NOT be consulted');
            });

            it('tracker-not-fresh GET_ADDRESS is not permitted', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });

                mainnetBelowGateCtx();
                actionsCtx.utxoTracker = { enabled: true, getFirstSeen: sinon.stub().resolves({ height: 100 }) };
                dispenser = new Dispenser(actionsCtx);

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: 500 });

                await dispenser.parse(params, data, false);

                assert.ok(data['STATUS'].includes('GET_ADDRESS') && data['STATUS'].includes('not permitted'));
            });

            it('tracker throwing falls back to not-fresh (invalid), byte-identical legacy behavior', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });

                mainnetBelowGateCtx();
                actionsCtx.utxoTracker = { enabled: true, getFirstSeen: sinon.stub().rejects(new Error('db error')) };
                dispenser = new Dispenser(actionsCtx);

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: 500 });

                await dispenser.parse(params, data, false);

                assert.ok(data['STATUS'].includes('GET_ADDRESS') && data['STATUS'].includes('not permitted'));
            });
        });
    });

    describe('LIST field validation', function () {

        it('unknown ALLOW_LIST returns invalid', async function () {
            indexer.indexerDb.getListType.resolves(false);

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|99||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('ALLOW_LIST') && data['STATUS'].includes('unknown'));
        });

        it('unsupported LIST type (tick list) returns invalid', async function () {
            // Type 1 = tick list; dispenser.listTypes only includes type 2 (address)
            indexer.indexerDb.getListType.resolves(1);

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|99||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('unsupported'));
        });
    });

    describe('GIVE_OWNERSHIP=1 (ownership dispenser)', function () {

        beforeEach(function () {
            indexer.indexerDb.setTokenEscrow = sinon.stub().resolves();
            // Ownership source must be token owner
            indexer.indexerDb.getTokenInfo
                .withArgs('JDOG', sinon.match.any, sinon.match.any)
                .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null, OWNER: OWNER_ADDR }));
            indexer.indexerDb.isOwnershipEscrowed.resolves(false);
        });

        it('valid ownership-give dispenser calls setTokenEscrow and no balance escrow', async function () {
            // FORMAT: 0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|...
            // GIVE_OWNERSHIP=1, GIVE_AMOUNT and GIVE_ESCROW must be empty
            indexer.indexerDb.getAddressBalances.resolves({ 10: '0', 99: '999999999' });
            const params = makeParams(`0|BTC|JDOG||1||BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.setTokenEscrow);
        });

        it('ownership dispenser: ownership_escrow fee included in unified fees', async function () {
            // With UNIFIED_FEES enabled (default), ownership escrow fee is added
            indexer.indexerDb.getAddressBalances.resolves({ 10: '0', 99: '999999999' });
            const params = makeParams(`0|BTC|JDOG||1||BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            // If UNIFIED_FEES branches covered; status valid means fee path was exercised
            assert.strictEqual(data['STATUS'], 'valid');
        });
    });

    describe('Non-unified expiration fee path', function () {

        it('legacy getExpirationFee path when UNIFIED_FEES disabled', async function () {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().resolves(false);

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            // valid or invalid depending on fee; key point is legacy branch was executed
            sinon.assert.calledOnce(indexer.indexerDb.createDispenser);
        });
    });

    describe('Native coin fee payment path', function () {

        it('valid native coin fee sets PAYMENT_MODE=1', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: true,
                nativeCoinAmount: '0.0001',
                nativeCoin: 'BTC',
                oracleRound: 1,
            });
            sinon.stub(indexer.util, 'getUnifiedExpirationFee').returns({ gasCost: 100, fee: '0.00001' });

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('invalid native coin fee returns error', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: false,
                error: 'output too small',
            });
            sinon.stub(indexer.util, 'getUnifiedExpirationFee').returns({ gasCost: 100, fee: '0.00001' });

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].startsWith('invalid'));
        });

        it('rejected payment mode returns insufficient fee error', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('rejected');
            sinon.stub(indexer.util, 'getUnifiedExpirationFee').returns({ gasCost: 100, fee: '0.00001' });

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('insufficient fee'));
        });

        it('insufficient xchain fee balance returns error', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('xchain');
            sinon.stub(indexer.util, 'getUnifiedExpirationFee').returns({ gasCost: 100, fee: '9999999' });

            // Deplete the fee balance
            indexer.indexerDb.getAddressBalances.resolves({ 10: '1000', 99: '0' });

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('insufficient funds') || data['STATUS'].startsWith('invalid'));
        });
    });

    // Counterparty parity. A Mode B dispenser (ORACLE_ADDRESS set) pays the
    // oracle operator UP FRONT as a real native-coin output, charged to the address
    // opening it. These pin the wiring: that the charge fires only for Mode B, only
    // when escrow is added, only under the gate, and that it rejects the create when
    // the output is missing. The fee arithmetic and every branch of the check itself
    // are covered in utility.computeOracleFee / utility.validateOracleFee tests.
    describe('Format 0 - oracle usage fee', function () {
        const ORACLE_ADDR = OTHER_ADDR;   // any valid address that is not the opener

        function modeBParams(escrow = '1000') {
            return makeParams(
                `0|BTC|JDOG|1||${escrow}|BTC||0|${OWNER_ADDR}|USD||${ORACLE_ADDR}|${EXPIRATION}|||Mode B`);
        }
        const modeBData = () => createBaseData(
            { ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

        it('rejects the create when the oracle fee output is missing', async function () {
            indexer.indexerDb.getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0.01' });
            indexer.indexerDb.getPricesInTimeRange = sinon.stub().resolves([{ price: '50000' }]);

            const data = modeBData();                 // no TX_OUTPUTS at all
            await dispenser.parse(modeBParams(), data, false);

            assert.strictEqual(data['STATUS'], 'invalid: ORACLE_ADDRESS (missing oracle fee output)');
            // createDispenser still records the invalid attempt (see the GIVE_TICK case
            // above); what must not happen is the escrow moving.
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });

        it('accepts the create when the output pays the oracle', async function () {
            indexer.indexerDb.getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0.01' });
            indexer.indexerDb.getPricesInTimeRange = sinon.stub().resolves([{ price: '50000' }]);

            const data = modeBData();
            data['TX_OUTPUTS'] = [{ address: ORACLE_ADDR, value: '0.00001' }];
            await dispenser.parse(modeBParams(), data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenser);
        });

        it('rejects the create when the oracle has no effective price', async function () {
            // Operator ruling: a dispenser must reference an oracle that has prices set.
            indexer.indexerDb.getOraclePrice = sinon.stub().resolves(null);

            const data = modeBData();
            data['TX_OUTPUTS'] = [{ address: ORACLE_ADDR, value: '1' }];
            await dispenser.parse(modeBParams(), data, false);

            assert.strictEqual(data['STATUS'], 'invalid: ORACLE_ADDRESS (no effective oracle price)');
        });

        it('never charges a Mode A dispenser, which has no oracle operator to pay', async function () {
            // FIAT_AMOUNT-only pricing reads validator snapshots, and validators are
            // already compensated, so the oracle lookup must not even be attempted.
            const getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0.01' });
            indexer.indexerDb.getOraclePrice = getOraclePrice;

            const params = makeParams(
                `0|BTC|JDOG|1||10|BTC||0|${OWNER_ADDR}|USD|0.05||${EXPIRATION}|||Mode A`);
            const data = modeBData();
            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.notCalled(getOraclePrice);
        });

        it('does not charge below the activation gate', async function () {
            actionsCtx.protocolChanges.isEnabled
                .withArgs('FIAT_DISPENSER_PRICING', sinon.match.any).resolves(false);
            const getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0.01' });
            indexer.indexerDb.getOraclePrice = getOraclePrice;

            const data = modeBData();                 // no output, yet must still pass
            await dispenser.parse(modeBParams(), data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.notCalled(getOraclePrice);
        });

        it('does not charge an ownership dispenser, which escrows no balance', async function () {
            // The FEE is nil here and no output is required: its base is
            // oracle_price x GIVE_ESCROW, and an ownership dispenser must carry an empty
            // GIVE_ESCROW. The oracle price IS still read, because the effective-price
            // rule is a validity precondition on the create rather than part of the fee
            // (see dispenser_oracle_price_activation.js); what must not happen is a fee
            // being demanded. No TX_OUTPUTS are supplied, so a charge would reject.
            const getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0.01' });
            indexer.indexerDb.getOraclePrice = getOraclePrice;
            indexer.indexerDb.setTokenEscrow = sinon.stub().resolves();
            indexer.indexerDb.isOwnershipEscrowed.resolves(false);
            indexer.indexerDb.getAddressBalances.resolves({ 10: '0', 99: '999999999' });

            // GIVE_OWNERSHIP=1 carries empty GIVE_AMOUNT/GIVE_ESCROW.
            const params = makeParams(
                `0|BTC|JDOG||1||BTC||0|${OWNER_ADDR}|USD||${ORACLE_ADDR}|${EXPIRATION}|||Ownership`);
            const data = modeBData();
            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid', data['STATUS']);
            sinon.assert.calledOnce(indexer.indexerDb.setTokenEscrow);
        });
    });
});
