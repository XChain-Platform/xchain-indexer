'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');
const gateRegistry      = require('../../../../src/consensus/gate_registry');

const TOKEN_GATE_LIST_AT_BLOCK_KEY = 'token_gate_list_at_block.TOKEN_GATE_LIST_AT_BLOCK';
const ADDR = 'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz';

function tokenGateDb(active, addressSleeping, tickSleeping) {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    sinon.stub(gateRegistry, 'activeAt').callThrough()
        .withArgs(TOKEN_GATE_LIST_AT_BLOCK_KEY).returns(active);
    sinon.stub(db, 'getTokenInfo').resolves({ ALLOW_LIST: null, BLOCK_LIST: null });
    sinon.stub(db, 'isAddressSleeping').resolves(addressSleeping);
    sinon.stub(db, 'isTickSleeping').resolves(tickSleeping);
    return db;
}

afterEach(function () { sinon.restore(); });

describe('db.isActionAllowed() token gate sleep scope @regression @tier1', function () {
    for (const active of [false, true]) {
        const state = active ? 'active' : 'inactive';

        it(`ignores address sleep when the list block pin is ${state}`, async function () {
            const db = tokenGateDb(active, true, false);
            assert.strictEqual(await db.isActionAllowed(ADDR, 'TEST', 100), true);
        });

        it(`ignores token sleep when the list block pin is ${state}`, async function () {
            const db = tokenGateDb(active, false, true);
            assert.strictEqual(await db.isActionAllowed(ADDR, 'TEST', 100), true);
        });
    }

    it('does not read sleep state for an address-plus-token call', async function () {
        const db = tokenGateDb(true, true, true);
        assert.strictEqual(await db.isActionAllowed(ADDR, 'TEST', 100), true);
        assert.strictEqual(db.isAddressSleeping.callCount, 0);
        assert.strictEqual(db.isTickSleeping.callCount, 0);
    });

    it('still rejects an address-only call when the address is sleeping', async function () {
        const db = tokenGateDb(true, true, false);
        assert.strictEqual(await db.isActionAllowed(ADDR, null, 100), false);
        assert.ok(db.isAddressSleeping.calledOnceWithExactly(ADDR, 100));
    });

    it('still rejects a token-only call when the token is sleeping', async function () {
        const db = tokenGateDb(true, false, true);
        assert.strictEqual(await db.isActionAllowed(null, 'TEST', 100), false);
        assert.ok(db.isTickSleeping.calledOnceWithExactly('TEST', 100));
    });
});
