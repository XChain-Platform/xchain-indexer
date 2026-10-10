// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const maturitySql = require('../../../../src/db/rollback/cooldown_maturities.js');

describe('cooldown maturity escrow release reversal @regression @tier3', function () {
    it('deletes each legacy refund credit together with its paired negative escrow release', async function () {
        const db = { doQuery: sinon.stub().resolves([]) };

        await maturitySql.reverseMaturedRefunds(db, 'XCHAIN', 7, 3, 100);

        const calls = db.doQuery.getCalls();
        const capEscrowDel = calls.find(c => /DELETE e FROM escrows e/.test(c.args[0]) && /JOIN unstakes u/.test(c.args[0]));
        const conEscrowDel = calls.find(c => /DELETE e FROM escrows e/.test(c.args[0]) && /JOIN contract_unstakes cu/.test(c.args[0]));
        assert.ok(capEscrowDel, 'expected the capability maturity escrow release to be deleted');
        assert.ok(conEscrowDel, 'expected the contract maturity escrow release to be deleted');
        assert.match(capEscrowDel.args[0], /u\.action_index = e\.action_index AND u\.source_id = e\.address_id/);
        assert.match(capEscrowDel.args[0], /g\.id = e\.tick_id AND g\.tick = \?/);
        assert.match(conEscrowDel.args[0], /cu\.action_index = e\.action_index/);
        assert.match(conEscrowDel.args[0], /cu\.source_id\s*= e\.address_id/);
        assert.match(conEscrowDel.args[0], /cu\.tick_id\s*= e\.tick_id/);
        assert.match(capEscrowDel.args[0], /CAST\(e\.amount AS DECIMAL\(60,18\)\) < 0/);
        assert.match(conEscrowDel.args[0], /CAST\(e\.amount AS DECIMAL\(60,18\)\) < 0/);
        assert.deepStrictEqual(capEscrowDel.args[1], ['XCHAIN', 7, 100, 100]);
        assert.deepStrictEqual(conEscrowDel.args[1], [7, 100, 100]);
    });
});
