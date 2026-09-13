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
// in the per-leg SEND loop the SOURCE sleeping check
// isActionAllowed(SOURCE, null, BLOCK) is byte-identical every leg, and the TICK
// sleeping check isActionAllowed(null, TICK, BLOCK) repeats per leg for the same
// tick. The SOURCE check is now hoisted once before the loop and the TICK check is
// memoized per distinct tick, mirroring the ticks/preferences/gatedKeyHashes dedupe.
// The DESTINATION+TICK check stays per-leg (varies by recipient) and must be
// unaffected. This pins the query counts without changing any leg's outcome.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');
const Send = require('../../../src/actions/send.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DEST1  = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';
const DEST2  = 'n2j7X44Gm6P4E9cs2H13EkBAotYbjPZW17';

describe('Send isActionAllowed memoization @regression', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
            processAction:   sinon.stub().resolves(),
        };
        handler = new Send(actionsCtx);
        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 }));
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getAddressBalances.resolves({ 1: 100000 });
        indexer.indexerDb.findMatchingDispensers.resolves([]);
        indexer.indexerDb.findDispenserSends.resolves([]);
    });

    afterEach(() => sinon.restore());

    it('multi-send same tick to two recipients: SOURCE check hoisted once, TICK check memoized once', async function () {
        // format 2: VERSION|TICK|AMOUNT|DESTINATION|TICK|AMOUNT|DESTINATION|MEMO
        const params = ['2', 'TEST', '10', DEST1, 'TEST', '20', DEST2, ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 2, SOURCE, BLOCK_INDEX: 100 });

        await handler.parse(params, data, null);

        const ia = indexer.indexerDb.isActionAllowed;

        // SOURCE sleeping check: isActionAllowed(SOURCE, null, BLOCK) - once, not once-per-leg.
        const sourceSleep = ia.getCalls().filter(c => c.args[0] === SOURCE && c.args[1] === null);
        assert.strictEqual(sourceSleep.length, 1, 'SOURCE sleeping check runs exactly once for the whole tx');
        assert.strictEqual(sourceSleep[0].args[2], 100, 'checked at the tx BLOCK_INDEX');

        // TICK sleeping check: isActionAllowed(null, TICK, BLOCK) - once per distinct tick.
        const tickSleep = ia.getCalls().filter(c => c.args[0] === null && c.args[1] === 'TEST');
        assert.strictEqual(tickSleep.length, 1, 'TICK sleeping check memoized: one query for the repeated tick');

        // DESTINATION+TICK check stays per-leg (distinct recipients), untouched by this change.
        const destChecks = ia.getCalls().filter(c => (c.args[0] === DEST1 || c.args[0] === DEST2) && c.args[1] === 'TEST');
        const destAddrs  = new Set(destChecks.map(c => c.args[0]));
        assert.deepStrictEqual([...destAddrs].sort(), [DEST1, DEST2].sort(), 'per-recipient DESTINATION gate still runs for each leg');
    });

    it('sleeping SOURCE still rejects every leg (hoist did not drop the gate)', async function () {
        indexer.indexerDb.isActionAllowed.callsFake(async (addr, tick /*, block*/) => {
            if (addr === SOURCE && tick === null) return false; // SOURCE asleep
            return true;
        });
        const params = ['2', 'TEST', '10', DEST1, 'TEST', '20', DEST2, ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 2, SOURCE, BLOCK_INDEX: 100 });

        await handler.parse(params, data, null);

        const sends = indexer.indexerDb.createSend.getCalls().map(c => c.args[0]['STATUS']);
        assert.ok(sends.length >= 1, 'a send record is written per leg');
        assert.ok(sends.every(s => s === 'invalid: SOURCE (sleeping)'), 'both legs rejected as SOURCE sleeping');
    });

    it('sleeping TICK still rejects (memo returns the same false for every leg)', async function () {
        indexer.indexerDb.isActionAllowed.callsFake(async (addr, tick /*, block*/) => {
            if (addr === null && tick === 'TEST') return false; // TICK asleep
            return true;
        });
        const params = ['2', 'TEST', '10', DEST1, 'TEST', '20', DEST2, ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 2, SOURCE, BLOCK_INDEX: 100 });

        await handler.parse(params, data, null);

        const sends = indexer.indexerDb.createSend.getCalls().map(c => c.args[0]['STATUS']);
        assert.ok(sends.every(s => s === 'invalid: TICK (sleeping)'), 'both legs rejected as TICK sleeping');
    });
});
