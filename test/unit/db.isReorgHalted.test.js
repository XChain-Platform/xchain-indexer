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
 **********************************************************************
 * test/unit/db.isReorgHalted.test.js
 *
 * : the decoder writes a durable REORG_HALT marker into its events table
 * when it halts on a reorg it cannot safely rewind, but the indexer only ever
 * selects code='REORG', so a halted decoder is invisible (looks idle/lagging).
 * isReorgHalted() probes for the marker on decoderDb using the same throwing read
 * contract (doQueryStrict) as getReorgsSince.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

describe('db.isReorgHalted ()', function () {

    afterEach(() => sinon.restore());

    it('returns halted:true with the marker payload when a REORG_HALT row exists', async function () {
        const db = makeDb();
        const strict = sinon.stub(db, 'doQueryStrict').resolves([{ data: 'reorg depth 12 exceeds safe rewind' }]);
        const r = await db.isReorgHalted();
        assert.deepStrictEqual(r, { halted: true, payload: 'reorg depth 12 exceeds safe rewind' });
        assert.match(strict.firstCall.args[0], /REORG_HALT/);
    });

    it('returns halted:false, payload null when no REORG_HALT row exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').resolves([]);
        assert.deepStrictEqual(await db.isReorgHalted(), { halted: false, payload: null });
    });

    it('propagates a read fault (throwing contract, no silent "not halted")', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').rejects(new Error('decoder read fault'));
        await assert.rejects(() => db.isReorgHalted(), /decoder read fault/);
    });
});
