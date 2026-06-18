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
 **********************************************************************
 * test/unit/db.findSwapMatches-ownership-null.test.js
 *
 * REGRESSION GUARD for findSwapMatches() ownership-swap pairing (#3749).
 *
 * Ownership swaps store NULL give_amount/get_amount. The match query paired
 * swaps with bare amount equality (s1.give_amount=s2.get_amount), but SQL
 * NULL = NULL is NULL (not true), so every ownership swap was dropped by the
 * WHERE before it could be returned; ownership swaps escrowed but never filled.
 * The fix makes the two amount equalities NULL-aware (pair when both sides are
 * NULL), mirroring findOrderMatches' null-side handling.
 *
 * This guards the generated SQL carries the NULL-aware predicates. The runtime
 * pairing semantics against MariaDB are proven by the real-DB drill in
 * claude/scratch/findswapmatches-null-pairing-drill.js.
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
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
}

afterEach(function () { sinon.restore(); });

describe('findSwapMatches() ownership-swap NULL pairing @regression @tier1', function () {

    it('the match query pairs amounts NULL-aware, not by bare equality', async function () {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(42);
        const query = sinon.stub(db, 'doQuery').resolves([]);

        await db.findSwapMatches({ SOURCE: 'addr', ACTION_INDEX: 7 });

        sinon.assert.calledOnce(query);
        const sql = query.firstCall.args[0].replace(/\s+/g, ' ');

        // Both legs must accept a NULL=NULL pairing (ownership), not only equality.
        assert.match(sql, /\(\s*s1\.give_amount\s*=\s*s2\.get_amount\s+OR\s*\(\s*s1\.give_amount\s+IS\s+NULL\s+AND\s+s2\.get_amount\s+IS\s+NULL\s*\)\s*\)/i,
            'give-side amount predicate must pair NULL ownership legs');
        assert.match(sql, /\(\s*s1\.get_amount\s*=\s*s2\.give_amount\s+OR\s*\(\s*s1\.get_amount\s+IS\s+NULL\s+AND\s+s2\.give_amount\s+IS\s+NULL\s*\)\s*\)/i,
            'get-side amount predicate must pair NULL ownership legs');

        // Negative guard: the pre-fix bare equality (no NULL branch) must be gone.
        assert.doesNotMatch(sql, /s1\.give_amount\s*=\s*s2\.get_amount\s+AND\s+s1\.get_amount\s*=\s*s2\.give_amount\s+AND/i,
            'bare amount equality (drops every ownership swap) must not remain');
    });
});
