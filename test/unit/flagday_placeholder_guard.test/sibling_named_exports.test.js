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
 * the hub-only GOV_SNAPSHOT_ACTIVATION declaration, and the byte identity of
 * the three retraction_signing_activation.js copies. Part of the suite whose
 * entry is test/unit/flagday_placeholder_guard.test.js; each case is pending
 * when its sibling checkout is absent or refused.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
const { readSiblingModuleSource } = require('../../helpers/sibling_module_source.js');

const SRC = path.join(__dirname, '..', '..', '..', 'src');

const RATIFIED_BTC_HEIGHT = 963000;

describe('flag-day placeholder guard @regression @tier1', function () {
    describe('sibling copies carry no placeholder regression', function () {
        // same reasoning: the PRICE v0 signature-tally gate is armed to the
        // ratified 963000 anchor, so it belongs to the height cohort this file guards.
        // A substring check on the docs file is vacuous here (several maps carry that
        // literal), so bind it by NAMED EXPORT to both the ratified height and the local
        // copy: a re-anchor that moves one side and not the other now trips CI.
        it('xchain-documentation/protocol/constants.js pins PRICE_SIG_TALLY_ACTIVATION by named export, value-equal to the local copy', function () {
            const p = path.resolve(__dirname, '../../../../xchain-documentation/protocol/constants.js');
            const sibling = siblingCheckout(__dirname, p);
            if (!sibling.usable) return skipOrFail(this, sibling, 'the PRICE_SIG_TALLY_ACTIVATION docs pin');
            const canon = require(p);
            assert.ok(canon.PRICE_SIG_TALLY_ACTIVATION && typeof canon.PRICE_SIG_TALLY_ACTIVATION === 'object',
                'constants.js must export a PRICE_SIG_TALLY_ACTIVATION map (the canonical authority for the indexer + hub copies)');
            assert.strictEqual(canon.PRICE_SIG_TALLY_ACTIVATION.mainnet, RATIFIED_BTC_HEIGHT,
                'canonical PRICE signature-tally mainnet height must be the ratified ' + RATIFIED_BTC_HEIGHT);
            const local = require(path.join(SRC, 'price_sig_tally_activation.js')).PRICE_SIG_TALLY_ACTIVATION;
            assert.deepStrictEqual(local, canon.PRICE_SIG_TALLY_ACTIVATION,
                'the local price_sig_tally_activation.js map drifted from the canonical constants.js map');
        });

        // same reasoning again for the remaining two cohort members.
        it('xchain-documentation/protocol/constants.js pins ATTEST_RELAY_ACTIVATION and ARCHIVE_REWARD_ACTIVATION by named export', function () {
            const p = path.resolve(__dirname, '../../../../xchain-documentation/protocol/constants.js');
            const sibling = siblingCheckout(__dirname, p);
            if (!sibling.usable) return skipOrFail(this, sibling, 'the ATTEST_RELAY and ARCHIVE_REWARD docs pins');
            const canon = require(p);
            for (const [mapName, file] of [
                ['ATTEST_RELAY_ACTIVATION',   'attest_relay_activation.js'],
                ['ARCHIVE_REWARD_ACTIVATION', 'anchor_reward_activation.js'],
            ]) {
                assert.ok(canon[mapName] && typeof canon[mapName] === 'object',
                    'constants.js must export a ' + mapName + ' map');
                assert.strictEqual(canon[mapName].mainnet, RATIFIED_BTC_HEIGHT,
                    'canonical ' + mapName + ' mainnet height must be the cohort height ' + RATIFIED_BTC_HEIGHT);
                assert.deepStrictEqual(require(path.join(SRC, file))[mapName], canon[mapName],
                    'the local ' + file + ' ' + mapName + ' map drifted from the canonical constants.js map');
            }
        });
    });
});

describe('flag-day placeholder guard @regression @tier1', function () {
    describe('sibling copies carry no placeholder regression', function () {
        // GOV_SNAPSHOT_ACTIVATION is the fifth cohort member and the only one
        // that is hub-only and NOT exported: it is a file-local const inside
        // Governance.js. Requiring that module from here would drag in the whole hub
        // engine, so read the declaration out of the source instead. It still has to be
        // asserted somewhere, because it was the third file named and without this
        // case nothing in this tree fails when a re-pin passes it by.
        it('xchain-hub/src/validators/governance.js declares GOV_SNAPSHOT_ACTIVATION at the cohort height', function () {
            const p = path.resolve(__dirname, '../../../../xchain-hub/src/validators/governance.js');
            const sibling = siblingCheckout(__dirname, p);
            if (!sibling.usable) return skipOrFail(this, sibling, 'the GOV_SNAPSHOT_ACTIVATION hub pin');
            // The entry keeps the require path while the hub moves method bodies into
            // same-stem part files beside it, so a declaration that is file-local to the
            // module can sit in either. Read the module whole (entry plus parts) or a
            // split that never touched the value reads as a missing declaration.
            const m = readSiblingModuleSource(p)
                .match(/const\s+GOV_SNAPSHOT_ACTIVATION\s*=\s*\{\s*mainnet:\s*(\d+)\s*,\s*testnet:\s*(\d+)\s*,\s*regtest:\s*(\d+)\s*\}/);
            assert.ok(m, 'GOV_SNAPSHOT_ACTIVATION declaration not found in validators/governance.js or its part files (renamed or reshaped?)');
            assert.strictEqual(parseInt(m[1]), RATIFIED_BTC_HEIGHT,
                'GOV_SNAPSHOT_ACTIVATION.mainnet is ' + m[1] + ', not the cohort height ' + RATIFIED_BTC_HEIGHT);
            assert.strictEqual(parseInt(m[2]), 0, 'GOV_SNAPSHOT_ACTIVATION.testnet must be genesis-active');
            assert.strictEqual(parseInt(m[3]), 0, 'GOV_SNAPSHOT_ACTIVATION.regtest must be genesis-active');
        });
    });
});

describe('flag-day placeholder guard @regression @tier1', function () {
    // retraction_signing_activation.js is a fork-relevant flag-day twin that
    // exists in three byte-identical copies (hub, indexer, explorer). It decides
    // whether a mirror REFUSES an unsigned quorum-class retraction, so a one-sided edit
    // (a comparator flip >= -> >, a testnet/regtest value change, an added second map,
    // or any body rewrite) would let the hub sign under one era rule while a mirror
    // enforces another - with no CI signal. The entry's substring checks only prove the
    // literal `mainnet: 963000` appears SOMEWHERE in each copy; they pass through all of
    // those drifts. Assert full-file byte-identity of the hub and explorer copies against
    // the local indexer copy (all three are byte-identical today, headers included, so a
    // plain string compare is correct). Same skip machinery as the sibling sweep above.
    describe('retraction_signing_activation.js is byte-identical across hub/indexer/explorer', function () {
        const LOCAL = path.join(SRC, 'retraction_signing_activation.js');
        const SIBLING_TWINS = [
            '../../../../xchain-hub/src/retraction_signing_activation.js',
            '../../../../xchain-explorer/src/retraction_signing_activation.js',
        ];
        for (const rel of SIBLING_TWINS) {
            it(rel.replace(/^(\.\.\/)+/, '') + ' is byte-identical to the indexer copy', function () {
                const p = path.resolve(__dirname, rel);
                const verdict = siblingCheckout(__dirname, p);
                if (!verdict.usable) return skipOrFail(this, verdict, 'the retraction twin byte identity of ' + rel);
                const local   = fs.readFileSync(LOCAL, 'utf8');
                const sibling = fs.readFileSync(p, 'utf8');
                assert.strictEqual(sibling, local,
                    p + ' has diverged from the indexer copy of retraction_signing_activation.js. ' +
                    'All three copies (hub, indexer, explorer) must stay byte-identical; a one-sided ' +
                    'edit to this flag-day twin forks retraction acceptance between the hub and its ' +
                    'mirrors. Reconcile the three copies.');
            });
        }
    });
});
