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
 * test/unit/hub_db_sync_grace_resolver.test.js
 *
 * Watermark-grace resolver ( / Package 12). The three barrier grace
 * margins are frozen protocol constants (600/600/120): a per-node divergence
 * forks settlement, and a NaN value wedges the tip via `blockTime + NaN`. The
 * resolver pins the constants, ignores env overrides off-regtest with a loud
 * warning (mirroring resolveFeeDestination), honors them only on regtest for
 * test tunability, and THROWS on a malformed regtest override rather than
 * swallowing it. These tests drive the real constructor wiring, both sides of
 * the regtest / off-regtest branch.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync = require('../../src/hub_db_sync.js');

const GRACE_ENV = ['HUB_SYNC_PRICE_GRACE_S', 'HUB_SYNC_ORACLE_GRACE_S', 'HUB_SYNC_MATCH_GRACE_S'];

function clearGraceEnv() {
    for (const k of GRACE_ENV) delete process.env[k];
}

function makeSync(network) {
    const doQuery = sinon.stub().callsFake(async () => [{ h: 0 }]);
    return new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network });
}

describe('HubDbSync watermark-grace resolver  @regression @tier1', function () {

    afterEach(function () {
        clearGraceEnv();
        sinon.restore();
    });

    it('defaults to the frozen protocol constants 600/600/120 when no env is set', function () {
        clearGraceEnv();
        const sync = makeSync('mainnet');
        assert.strictEqual(sync.priceWatermarkGraceS, 600);
        assert.strictEqual(sync.oracleWatermarkGraceS, 600);
        assert.strictEqual(sync.matchWatermarkGraceS, 120);
    });

    it('regtest honors a valid env override (test tunability)', function () {
        clearGraceEnv();
        process.env.HUB_SYNC_PRICE_GRACE_S  = '60';
        process.env.HUB_SYNC_ORACLE_GRACE_S = '90';
        process.env.HUB_SYNC_MATCH_GRACE_S  = '0';
        const sync = makeSync('regtest');
        assert.strictEqual(sync.priceWatermarkGraceS, 60);
        assert.strictEqual(sync.oracleWatermarkGraceS, 90);
        assert.strictEqual(sync.matchWatermarkGraceS, 0, 'grace 0 (no wait) is a valid non-negative integer');
    });

    it('off-regtest IGNORES an env override with a loud warning and keeps the frozen constant', function () {
        clearGraceEnv();
        const warn = sinon.stub(console, 'log');
        process.env.HUB_SYNC_PRICE_GRACE_S = '60';
        const sync = makeSync('mainnet');
        assert.strictEqual(sync.priceWatermarkGraceS, 600, 'mainnet must ignore the override and pin 600');
        assert.ok(
            warn.getCalls().some(c => String(c.args[0]).includes('HUB_SYNC_PRICE_GRACE_S') &&
                                      String(c.args[0]).includes('IGNORED')),
            'a loud IGNORED warning must be emitted off-regtest'
        );
    });

    it('off-regtest does not warn when the override equals the frozen value', function () {
        clearGraceEnv();
        const warn = sinon.stub(console, 'log');
        process.env.HUB_SYNC_ORACLE_GRACE_S = '600';
        const sync = makeSync('testnet');
        assert.strictEqual(sync.oracleWatermarkGraceS, 600);
        assert.ok(
            !warn.getCalls().some(c => String(c.args[0]).includes('HUB_SYNC_ORACLE_GRACE_S')),
            'no warning when the override matches the pinned constant'
        );
    });

    it('regtest THROWS an actionable error on a negative override', function () {
        clearGraceEnv();
        process.env.HUB_SYNC_MATCH_GRACE_S = '-5';
        assert.throws(() => makeSync('regtest'), /HUB_SYNC_MATCH_GRACE_S.*non-negative integer/);
    });

    it('regtest THROWS on a fractional override', function () {
        clearGraceEnv();
        process.env.HUB_SYNC_PRICE_GRACE_S = '60.5';
        assert.throws(() => makeSync('regtest'), /HUB_SYNC_PRICE_GRACE_S.*non-negative integer/);
    });

    it('regtest THROWS on an unparseable (NaN) override', function () {
        clearGraceEnv();
        process.env.HUB_SYNC_ORACLE_GRACE_S = 'soon';
        assert.throws(() => makeSync('regtest'), /HUB_SYNC_ORACLE_GRACE_S.*non-negative integer/);
    });

    it('an empty-string override is treated as unset (frozen constant)', function () {
        clearGraceEnv();
        process.env.HUB_SYNC_PRICE_GRACE_S = '';
        const sync = makeSync('regtest');
        assert.strictEqual(sync.priceWatermarkGraceS, 600);
    });
});
