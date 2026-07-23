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
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Dispenser_Close = require('../../../src/actions/dispenser_close.js');

describe('Dispenser_Close action handler @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    function makeDispenser(overrides) {
        return {
            ACTION_INDEX: 50,
            SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            GIVE_TICK: 'TEST',
            GIVE_REMAINING: '200',
            GET_ADDRESS: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            ...overrides,
        };
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config: indexer.config,
            util: indexer.util,
            mapper: indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
        handler = new Dispenser_Close(actionsCtx);
        indexer.util.resetLists();
    });

    it('does nothing when dispenser is not found', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(null);
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createDispenserClose.notCalled);
    });

    it('creates a dispenser_close record when dispenser exists', async function () {
        const dispenser = makeDispenser();
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createDispenserClose.calledOnce);
    });

    it('creates a dispenser status record', async function () {
        const dispenser = makeDispenser();
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createDispenserStatus.calledOnce);
    });

    it('credits remaining tokens to SOURCE when no sweep destination', async function () {
        const dispenser = makeDispenser({ GIVE_REMAINING: '150' });
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        indexer.indexerDb.getSweepDestination.resolves(null);
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createDispenserClose.calledOnce);
    });

    it('credits remaining tokens to sweep destination when available', async function () {
        const SWEEP_DEST = 'mqmJDcs5nXFHrj9q7a2G5sBVmjcQTDdUZp';
        const dispenser = makeDispenser({ GIVE_REMAINING: '150' });
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        indexer.indexerDb.getSweepDestination.resolves(SWEEP_DEST);
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);
        // Destination should have been tracked in addresses list
        const addresses = indexer.util.getAddressesList();
        assert.ok(Object.keys(addresses).includes(SWEEP_DEST), 'Sweep destination should be tracked');
    });

    it('calls updateBalances after processing', async function () {
        const dispenser = makeDispenser();
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.updateBalances.calledOnce);
    });

    it('calls mapper.createMappings after processing', async function () {
        const dispenser = makeDispenser();
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });

    it('ownership dispenser: clearTokenEscrow when escrow matches and destination is SOURCE', async function () {
        const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
        const dispenser = makeDispenser({ GIVE_OWNERSHIP: 1, ACTION_INDEX: 50, SOURCE });
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        indexer.indexerDb.getSweepDestination.resolves(null);
        indexer.indexerDb.getDispenserCanceller.resolves(null);
        // escrow matches dispenser.ACTION_INDEX → ownership path executes
        indexer.indexerDb.getTokenEscrow = sinon.stub().resolves(50);
        indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();

        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);

        sinon.assert.calledOnce(indexer.indexerDb.clearTokenEscrow);
    });

    it('ownership dispenser: transferTokenOwnership when escrow matches and destination differs from SOURCE', async function () {
        const SOURCE   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
        const DEST     = 'mqmJDcs5nXFHrj9q7a2G5sBVmjcQTDdUZp';
        const dispenser = makeDispenser({ GIVE_OWNERSHIP: 1, ACTION_INDEX: 50, SOURCE });
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        indexer.indexerDb.getSweepDestination.resolves(DEST);  // sweep → destination != SOURCE
        indexer.indexerDb.getTokenEscrow = sinon.stub().resolves(50);
        indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
        // transferTokenOwnership is a util method; stub it
        sinon.stub(indexer.util, 'transferTokenOwnership').resolves();

        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);

        sinon.assert.calledOnce(indexer.util.transferTokenOwnership);
        sinon.assert.notCalled(indexer.indexerDb.clearTokenEscrow);
    });

    it('ownership dispenser: no action when escrow does not match (already cleared by DISPENSE)', async function () {
        const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
        const dispenser = makeDispenser({ GIVE_OWNERSHIP: 1, ACTION_INDEX: 50, SOURCE });
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        indexer.indexerDb.getSweepDestination.resolves(null);
        indexer.indexerDb.getDispenserCanceller.resolves(null);
        // escrow is already cleared (returns null/different action_index)
        indexer.indexerDb.getTokenEscrow = sinon.stub().resolves(null);
        indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();

        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);

        sinon.assert.notCalled(indexer.indexerDb.clearTokenEscrow);
        sinon.assert.calledOnce(indexer.indexerDb.createDispenserClose);
    });

    it('canceller address is used as destination when no sweep and canceller set', async function () {
        const CANCELLER = 'mqmJDcs5nXFHrj9q7a2G5sBVmjcQTDdUZp';
        const dispenser = makeDispenser({ GIVE_REMAINING: '100' });
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        indexer.indexerDb.getSweepDestination.resolves(null);
        indexer.indexerDb.getDispenserCanceller.resolves(CANCELLER);

        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);

        // Destination should have been tracked in addresses list
        const addresses = indexer.util.getAddressesList();
        assert.ok(Object.keys(addresses).includes(CANCELLER), 'Canceller address should be tracked as destination');
    });

    it('negates the escrow return at full precision (no unary-minus float truncation)', async function () {
        // Same hazard as DISPENSER_EXPIRE: -GIVE_REMAINING on an 18-decimal
        // bignumber string truncates to a float and desyncs the escrow return from
        // the full-precision credit; bcsub negates without losing digits.
        const REMAINING = '5.123456789012345678';
        const dispenser = makeDispenser({ GIVE_REMAINING: REMAINING });
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        indexer.indexerDb.getSweepDestination.resolves(null);
        indexer.indexerDb.getDispenserCanceller.resolves(null);
        const capture = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);
        assert.ok(capture.calledOnce, 'processTransactionLedgerChanges should be called');
        const escrows = capture.getCall(0).args[4];
        assert.strictEqual(escrows.length, 1, 'one escrow return is pushed');
        assert.strictEqual(String(escrows[0][1]), '-' + REMAINING, 'escrow return keeps all 18 decimals');
        assert.notStrictEqual(String(escrows[0][1]), String(-Number(REMAINING)), 'not the truncated JS-float negation');
    });

    // ── 1678: ownership cancel/expire routing flag-day ────────────────────────
    // Cancelling an OWNERSHIP dispenser must NOT hand the canceller (which may be
    // GET_ADDRESS) the token's issuer rights. Per DISPENSER.md:122 only a SWEEP
    // delivers ownership to a non-SOURCE destination; cancel/expire leave it with
    // SOURCE. Gated (dispenser_ownership_cancel_activation.js) so historical replay
    // stays byte-identical below the flag-day.
    describe('1678 ownership cancel/expire routing gate @regression @tier1', function () {
        const ocg      = require('../../../src/dispenser_ownership_cancel_activation.js');
        const FLAG_DAY = ocg.DISPENSER_OWNERSHIP_CANCEL_ACTIVATION.mainnet; // 1790812800
        const SOURCE   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
        const GET_ADDR = 'mqmJDcs5nXFHrj9q7a2G5sBVmjcQTDdUZp'; // != SOURCE, and the canceller
        const SWEEP    = 'mzMsvKm5N4vmAWKFDbwjc7hqCkGwANhCwn';

        // A GET_ADDRESS-cancelled ownership dispenser: no sweep, canceller = GET_ADDRESS.
        function cancelSetup() {
            const dispenser = makeDispenser({ GIVE_OWNERSHIP: 1, ACTION_INDEX: 50, SOURCE, GET_ADDRESS: GET_ADDR });
            indexer.indexerDb.getDispenserInfo.resolves(dispenser);
            indexer.indexerDb.getSweepDestination.resolves(null);
            indexer.indexerDb.getDispenserCanceller.resolves(GET_ADDR);
            indexer.indexerDb.getTokenEscrow = sinon.stub().resolves(50); // matches ACTION_INDEX
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
            sinon.stub(indexer.util, 'transferTokenOwnership').resolves();
        }

        it('mainnet below the flag-day keeps legacy routing (canceller acquires ownership) for byte-identical replay', async function () {
            actionsCtx.config.NETWORK = 'mainnet';
            cancelSetup();
            const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'cancelled', BLOCK_TIME: FLAG_DAY - 1 });
            await handler.parse(null, data, null);
            sinon.assert.calledOnce(indexer.util.transferTokenOwnership);
            assert.strictEqual(indexer.util.transferTokenOwnership.getCall(0).args[5], GET_ADDR, 'legacy: ownership routed to the canceller');
            sinon.assert.notCalled(indexer.indexerDb.clearTokenEscrow);
        });

        it('mainnet at/after the flag-day leaves ownership with SOURCE on a cancel (only clears the gate)', async function () {
            actionsCtx.config.NETWORK = 'mainnet';
            cancelSetup();
            const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'cancelled', BLOCK_TIME: FLAG_DAY });
            await handler.parse(null, data, null);
            sinon.assert.notCalled(indexer.util.transferTokenOwnership);
            sinon.assert.calledOnce(indexer.indexerDb.clearTokenEscrow);
        });

        it('at/after the flag-day a SWEEP still transfers ownership to the sweep destination', async function () {
            actionsCtx.config.NETWORK = 'mainnet';
            const dispenser = makeDispenser({ GIVE_OWNERSHIP: 1, ACTION_INDEX: 50, SOURCE, GET_ADDRESS: GET_ADDR });
            indexer.indexerDb.getDispenserInfo.resolves(dispenser);
            indexer.indexerDb.getSweepDestination.resolves(SWEEP);
            indexer.indexerDb.getTokenEscrow = sinon.stub().resolves(50);
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
            sinon.stub(indexer.util, 'transferTokenOwnership').resolves();
            const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'cancelled', BLOCK_TIME: FLAG_DAY });
            await handler.parse(null, data, null);
            sinon.assert.calledOnce(indexer.util.transferTokenOwnership);
            assert.strictEqual(indexer.util.transferTokenOwnership.getCall(0).args[5], SWEEP, 'sweep still delivers ownership to the sweep destination');
            sinon.assert.notCalled(indexer.indexerDb.clearTokenEscrow);
        });

        it('regtest is corrected from genesis: a cancel leaves ownership with SOURCE', async function () {
            actionsCtx.config.NETWORK = 'regtest';
            cancelSetup();
            const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'cancelled', BLOCK_TIME: 1 });
            await handler.parse(null, data, null);
            sinon.assert.notCalled(indexer.util.transferTokenOwnership);
            sinon.assert.calledOnce(indexer.indexerDb.clearTokenEscrow);
        });

        it('activation predicate: flips at the mainnet flag-day, genesis on testnet/regtest, off for unknown/bad input', function () {
            assert.strictEqual(ocg.isDispenserOwnershipCancelActive(FLAG_DAY - 1, 'mainnet'), false);
            assert.strictEqual(ocg.isDispenserOwnershipCancelActive(FLAG_DAY, 'mainnet'), true);
            assert.strictEqual(ocg.isDispenserOwnershipCancelActive(0, 'testnet'), true);
            assert.strictEqual(ocg.isDispenserOwnershipCancelActive(0, 'regtest'), true);
            assert.strictEqual(ocg.isDispenserOwnershipCancelActive(FLAG_DAY, 'stagenet'), false);
            assert.strictEqual(ocg.isDispenserOwnershipCancelActive('nonsense', 'mainnet'), false);
        });
    });
});
