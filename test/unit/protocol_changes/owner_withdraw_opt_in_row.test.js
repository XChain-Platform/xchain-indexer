'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const ProtocolChanges = require('../../../src/protocol_changes.js');
const { declaresOwnerWithdraw } = require('../../../src/actions/deploy/contract_meta.js');

const ENV = 'OWNER_WITHDRAW_OPT_IN_REGTEST_TIME';
const KEY = 'protocol_changes.changes.OWNER_WITHDRAW_OPT_IN';

// 2026-09-27T07:00:00Z, the testnet tip at the cut.
const TESTNET_INSTANT = 1790492400;

function build() {
    return new ProtocolChanges({ config: {}, util: {} }).changes.OWNER_WITHDRAW_OPT_IN;
}

describe('protocol_changes/OWNER_WITHDRAW_OPT_IN row @regression @tier1', function () {
    const saved = process.env[ENV];

    beforeEach(function () {
        delete process.env[ENV];
    });

    afterEach(function () {
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
    });

    it('sits after CONTROLLER_CUSTODY_GUARD in part 5, mainnet inert and testnet armed', function () {
        const rows = require('../../../src/protocol_changes/changes_5.js');
        assert.strictEqual(rows[rows.length - 1][0], 'OWNER_WITHDRAW_OPT_IN');
        assert.strictEqual(ProtocolChanges.OWNER_WITHDRAW_OPT_IN_MAINNET_TIME, ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.OWNER_WITHDRAW_OPT_IN_TESTNET_TIME, TESTNET_INSTANT);
        assert.deepStrictEqual(build(), {
            version_major: 0, version_minor: 2, version_revision: 0,
            mainnet_time: ProtocolChanges.UNARMED,
            testnet_time: TESTNET_INSTANT,
            regtest_time: 0,
            mainnet_block: 0, testnet_block: 0, regtest_block: 0,
        });
    });

    it('registers the row and both network constants', function () {
        assert.deepStrictEqual(ProtocolChanges.get(KEY), build());
        assert.strictEqual(ProtocolChanges.get('protocol_changes.OWNER_WITHDRAW_OPT_IN_MAINNET_TIME'),
            ProtocolChanges.UNARMED);
        assert.strictEqual(ProtocolChanges.get('protocol_changes.OWNER_WITHDRAW_OPT_IN_TESTNET_TIME'),
            TESTNET_INSTANT);
    });

    it('reads the regtest-only override when a fresh table is built', function () {
        process.env[ENV] = '9999999999';
        assert.strictEqual(build().regtest_time, 9999999999);
        process.env[ENV] = 'not-a-time';
        assert.strictEqual(build().regtest_time, 0);
    });
});

describe('contract_meta/declaresOwnerWithdraw @regression @tier1', function () {
    it('is true only for a plain-object meta whose ownerWithdraw is the boolean true', function () {
        assert.strictEqual(declaresOwnerWithdraw('{"name":"A","description":"B","ownerWithdraw":true}'), true);
        assert.strictEqual(declaresOwnerWithdraw('{"name":"A","description":"B"}'), false);
        assert.strictEqual(declaresOwnerWithdraw('{"ownerWithdraw":false}'), false);
        assert.strictEqual(declaresOwnerWithdraw('{"ownerWithdraw":"true"}'), false);
        assert.strictEqual(declaresOwnerWithdraw('{"ownerWithdraw":1}'), false);
        assert.strictEqual(declaresOwnerWithdraw('[{"ownerWithdraw":true}]'), false);
        assert.strictEqual(declaresOwnerWithdraw('true'), false);
        assert.strictEqual(declaresOwnerWithdraw('null'), false);
        assert.strictEqual(declaresOwnerWithdraw('{bad json'), false);
        assert.strictEqual(declaresOwnerWithdraw(null), false);
        assert.strictEqual(declaresOwnerWithdraw(undefined), false);
    });

    it('does not read an inherited ownerWithdraw', function () {
        assert.strictEqual(declaresOwnerWithdraw('{"__proto__":{"ownerWithdraw":true}}'), false);
    });
});
