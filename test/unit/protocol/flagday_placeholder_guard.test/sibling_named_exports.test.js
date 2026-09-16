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
 *
 * The sibling half of the flag-day placeholder gate: the cohort maps that the
 * canonical xchain-documentation/protocol/constants.js pins by named export,
 * the hub-only GOV_SNAPSHOT_ACTIVATION registry row (or, on a hub that predates
 * the row, its module-local declaration), and the byte identity of
 * the three retraction_signing_activation.js copies. Part of the suite whose
 * entry is test/unit/flagday_placeholder_guard.test.js; each case is pending
 * when its sibling checkout is absent or refused.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');
const { readSiblingModuleSource } = require('../../../helpers/sibling_module_source.js');

const SRC = path.join(__dirname, '..', '..', '..', '..', 'src');
// The cohort rows are registry rows (W5 retired their predicate-only shims).
const registry = require(path.join(SRC, 'consensus', 'gate_registry'));

const RATIFIED_BTC_HEIGHT = 963000;

describe('flag-day placeholder guard @regression @tier1', function () {
    describe('sibling copies carry no placeholder regression', function () {
        // same reasoning: the PRICE v0 signature-tally gate is armed to the
        // ratified 963000 anchor, so it belongs to the height cohort this file guards.
        // A substring check on the docs file is vacuous here (several maps carry that
        // literal), so bind it by NAMED EXPORT to both the ratified height and the local
        // copy: a re-anchor that moves one side and not the other now trips CI.
        it('xchain-documentation/protocol/constants.js pins PRICE_SIG_TALLY_ACTIVATION by named export, value-equal to the local copy', function () {
            const p = path.resolve(__dirname, '../../../../../xchain-documentation/protocol/constants.js');
            const sibling = siblingCheckout(__dirname, p);
            if (!sibling.usable) return skipOrFail(this, sibling, 'the PRICE_SIG_TALLY_ACTIVATION docs pin');
            const canon = require(p);
            assert.ok(canon.PRICE_SIG_TALLY_ACTIVATION && typeof canon.PRICE_SIG_TALLY_ACTIVATION === 'object',
                'constants.js must export a PRICE_SIG_TALLY_ACTIVATION map (the canonical authority for the indexer + hub copies)');
            assert.strictEqual(canon.PRICE_SIG_TALLY_ACTIVATION.mainnet, RATIFIED_BTC_HEIGHT,
                'canonical PRICE signature-tally mainnet height must be the ratified ' + RATIFIED_BTC_HEIGHT);
            const local = registry.get('price_sig_tally_activation.PRICE_SIG_TALLY_ACTIVATION');
            assert.deepStrictEqual(local, canon.PRICE_SIG_TALLY_ACTIVATION,
                'the local price_sig_tally_activation registry row drifted from the canonical constants.js map');
        });

        // same reasoning again for the remaining two cohort members.
        it('xchain-documentation/protocol/constants.js pins ATTEST_RELAY_ACTIVATION and ARCHIVE_REWARD_ACTIVATION by named export', function () {
            const p = path.resolve(__dirname, '../../../../../xchain-documentation/protocol/constants.js');
            const sibling = siblingCheckout(__dirname, p);
            if (!sibling.usable) return skipOrFail(this, sibling, 'the ATTEST_RELAY and ARCHIVE_REWARD docs pins');
            const canon = require(p);
            for (const [mapName, key] of [
                ['ATTEST_RELAY_ACTIVATION',   'attest_relay_activation.ATTEST_RELAY_ACTIVATION'],
                ['ARCHIVE_REWARD_ACTIVATION', 'anchor_reward_activation.ARCHIVE_REWARD_ACTIVATION'],
            ]) {
                assert.ok(canon[mapName] && typeof canon[mapName] === 'object',
                    'constants.js must export a ' + mapName + ' map');
                assert.strictEqual(canon[mapName].mainnet, RATIFIED_BTC_HEIGHT,
                    'canonical ' + mapName + ' mainnet height must be the cohort height ' + RATIFIED_BTC_HEIGHT);
                assert.deepStrictEqual(registry.get(key), canon[mapName],
                    'the local ' + key + ' registry row drifted from the canonical constants.js map');
            }
        });
    });
});

describe('flag-day placeholder guard @regression @tier1', function () {
    describe('sibling copies carry no placeholder regression', function () {
        // GOV_SNAPSHOT_ACTIVATION is the fifth cohort member and the only one
        // that is hub-only and NOT exported: its value lives as a row of the
        // hub's activation registry, read by key from validators/governance/rules.js.
        // Requiring that module from here would drag in the whole hub engine, so read
        // the value out of the source instead. It still has to be asserted somewhere,
        // because it was the third file named and without this case nothing in this
        // tree fails when a re-pin passes it by.
        it('xchain-hub/src/validators/governance.js declares GOV_SNAPSHOT_ACTIVATION at the cohort height', function () {
            const p = path.resolve(__dirname, '../../../../../xchain-hub/src/validators/governance.js');
            const sibling = siblingCheckout(__dirname, p);
            if (!sibling.usable) return skipOrFail(this, sibling, 'the GOV_SNAPSHOT_ACTIVATION hub pin');
            // The table is a row of the hub's activation registry, in its hub-only
            // part; the governance module reads it by key. A hub that predates the
            // row still declares the literal inside the module (entry plus parts).
            const rowsPath = path.resolve(__dirname, '../../../../../xchain-hub/src/consensus/gate_registry/hub_rows.js');
            const rowText = fs.existsSync(rowsPath) ? fs.readFileSync(rowsPath, 'utf8') : '';
            const m = rowText.match(/^addGate\('validators\/governance\/rules\.GOV_SNAPSHOT_ACTIVATION',\s*'height',\s*\{\s*mainnet:\s*(\d+)\s*,\s*testnet:\s*(\d+)\s*,\s*regtest:\s*(\d+)\s*\}\);/m)
                || readSiblingModuleSource(p)
                    .match(/const\s+GOV_SNAPSHOT_ACTIVATION\s*=\s*\{\s*mainnet:\s*(\d+)\s*,\s*testnet:\s*(\d+)\s*,\s*regtest:\s*(\d+)\s*\}/);
            assert.ok(m, 'GOV_SNAPSHOT_ACTIVATION row not found in consensus/gate_registry/hub_rows.js nor declared in validators/governance.js or its part files (renamed or reshaped?)');
            assert.strictEqual(parseInt(m[1]), RATIFIED_BTC_HEIGHT,
                'GOV_SNAPSHOT_ACTIVATION.mainnet is ' + m[1] + ', not the cohort height ' + RATIFIED_BTC_HEIGHT);
            assert.strictEqual(parseInt(m[2]), 0, 'GOV_SNAPSHOT_ACTIVATION.testnet must be genesis-active');
            assert.strictEqual(parseInt(m[3]), 0, 'GOV_SNAPSHOT_ACTIVATION.regtest must be genesis-active');
        });
    });
});

