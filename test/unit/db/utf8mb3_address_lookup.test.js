/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb, dbWithDoQuery } = require('./db_queries.test/helpers/db_stub');

afterEach(function () {
    sinon.restore();
});

describe('utf8mb3 address lookup guard @regression @tier1', function () {
    it('queries for BMP strings, including three-byte characters', async function () {
        const db = dbWithDoQuery([]);
        const value = 'address-\u20ac';

        assert.strictEqual(await db.getAddressId(value), null);
        sinon.assert.calledOnceWithExactly(db.doQuery,
            "SELECT id FROM index_addresses WHERE `address`=? LIMIT 1", [value]);
    });

    it('returns not found without querying for supplementary characters', async function () {
        const db = dbWithDoQuery([]);

        assert.strictEqual(await db.getAddressId('x\ud83d\ude00'), null);
        sinon.assert.notCalled(db.doQuery);
    });

    it('does not query or insert supplementary characters through createAddress', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);

        assert.strictEqual(await db.createAddress('x\ud83d\ude00'), null);
        sinon.assert.notCalled(db.doQuery);
    });

    it('still resolves the 120-unit prefix when the supplementary character falls past it', async function () {
        const db = makeDb();
        const prefix = 'a'.repeat(120);
        sinon.stub(db, 'doQuery').resolves([{ id: 7 }]);

        assert.strictEqual(await db.createAddress(prefix + '\ud83d\ude00'), 7);
        sinon.assert.calledWith(db.doQuery, sinon.match.string, [prefix]);
    });

    it('returns absent activity and dispenser results without querying', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        const value = 'x\ud83d\ude00';

        assert.strictEqual(await db.hasXChainActivityBefore(value, 10), false);
        assert.strictEqual(await db.hasProvenUseBefore(value, 10), false);
        assert.strictEqual(await db.hasDispenserOriginStanding('source', value, 10), false);
        assert.strictEqual(await db.getClosedDispenserAtAddress('BTC', value), false);
        sinon.assert.notCalled(db.doQuery);
    });
});
