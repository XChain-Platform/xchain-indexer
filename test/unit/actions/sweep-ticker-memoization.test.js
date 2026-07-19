// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// : SWEEP resolved tick_id -> ticker with one getTicker query per held
// ticker TWICE over the same balance set (the controller-guard loop and the
// settlement balance-transfer loop). Resolution is now memoized per run, so each
// distinct held tick_id is resolved at most once across both passes. tick_id ->
// ticker is immutable within a block, so this changes only the query count, never
// which ticker a tick_id resolves to.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const Sweep = require('../../../src/actions/sweep.js');

const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DESTINATION = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

describe('Sweep tick_id->ticker memoization @regression ()', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.indexerDb.getAddressEscrows = sinon.stub().resolves([]);
        actionsCtx = {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
            processAction:   sinon.stub().resolves(),
        };
        handler = new Sweep(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(() => sinon.restore());

    it('resolves each distinct held tick_id at most once across both passes', async function () {
        // GAS (tick_id=1) plus two more held ticks. BALANCES=1 (default) so both the
        // controller-guard loop and the settlement loop iterate all three.
        indexer.indexerDb.getAddressBalances.resolves({ 1: '5', 2: '10', 3: '7' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getAddressOwnerships.resolves([]);
        indexer.indexerDb.isActionAllowed.resolves(true);
        const names = { 1: 'GAS', 2: 'AAA', 3: 'BBB' };
        indexer.indexerDb.getTicker.callsFake(async (id) => names[Number(id)]);

        const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
        const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS default to 1

        await handler.parse(params, data, null);

        assert.strictEqual(data['STATUS'], 'valid');

        // No tick_id is resolved more than once (memoized across the two passes).
        const argCounts = {};
        for (const c of indexer.indexerDb.getTicker.getCalls()) {
            const id = Number(c.args[0]);
            argCounts[id] = (argCounts[id] || 0) + 1;
        }
        for (const id of Object.keys(argCounts))
            assert.strictEqual(argCounts[id], 1, `tick_id ${id} resolved exactly once, not per pass`);

        // All three held ticks were still resolved (correctness of the sweep preserved).
        assert.deepStrictEqual(Object.keys(argCounts).map(Number).sort((a, b) => a - b), [1, 2, 3]);
    });
});
