/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/activationConstantsParity.test.js
 *
 * Arms the byte-equality claim each snapshot-block activation module's header
 * makes but that no suite previously enforced (review 2757 checkpoint_commitment,
 * 2758 cross_chain_royalty). Each module is a LOCAL COPY of the canonical map in
 * xchain-documentation/protocol/constants.js; a one-sided edit of any copy's
 * mainnet/testnet/regtest height forks the signed checkpoint / XMATCH canonical at
 * the flag-day with no CI failure. These modules are NOT in the reference-impl
 * conformance loop (no reference-impl copy exists) and cross_chain_royalty is not
 * vendored into xchain-sync, so the guard is anchored on the canonical constants.js
 * map that IS present. Skips green when the docs sibling is absent, unless
 * XCHAIN_REQUIRE_SIBLINGS=1 (CI) forces a hard failure.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CONSTANTS_PATH = path.resolve(__dirname, '../../../xchain-documentation/protocol/constants.js');

// module filename in src/ -> the named export it and constants.js share.
const GATES = [
    ['checkpoint_commitment_activation.js', 'CHECKPOINT_COMMITMENT_ACTIVATION'],
    ['cross_chain_royalty_activation.js',   'CROSS_CHAIN_ROYALTY_ACTIVATION'],
    ['attest_admission_activation.js',      'ATTEST_ADMISSION_ACTIVATION'],
    ['attest_request_cap_activation.js',    'ATTEST_REQUEST_CAP_ACTIVATION'],
    // Not an activation MAP but the consensus constants that gate reads: the caps decide
    // which requests are admitted at the flag-day exactly as the heights decide when.
    ['attest_request_cap_activation.js',    'ATTEST_REQUEST_CAPS'],
    ['attest_relay_activation.js',          'ATTEST_RELAY_ACTIVATION'],
    ['attest_broadcast_fee_activation.js',  'ATTEST_BROADCAST_FEE_ACTIVATION'],
    // Not an activation MAP but a consensus constant the same gate reads: the cap clamps the
    // escrow carve-out, so a one-sided edit changes the amount paid at the flag-day exactly as a
    // one-sided height edit changes when it is paid.
    ['attest_broadcast_fee_activation.js',  'ATTEST_BROADCAST_FEE_CAP'],
    ['anchor_reward_activation.js',         'ANCHOR_REWARD_DERIVE_ACTIVATION'],
    ['anchor_activation.js',                'ANCHOR_ACTIVATION'],
    // constants.js claims the whole anchor/archive reward block is "kept byte-identical to
    // the local copies ... by the cross-service regression suite"; these are the exports of
    // that block nothing else compared to canon (ARCHIVE_REWARD_ACTIVATION is locked by
    // flagdayPlaceholderGuard.test.js). The amounts and maturity are scalars, not maps.
    ['anchor_reward_activation.js',         'ANCHOR_REWARD_ACTIVATION'],
    ['anchor_reward_activation.js',         'ANCHOR_REWARD_AMOUNT'],
    ['anchor_reward_activation.js',         'ARCHIVE_REWARD_AMOUNT'],
    ['anchor_reward_activation.js',         'ANCHOR_REWARD_MIRROR_MATURITY'],
    ['price_pair_activation.js',            'PRICE_PAIR_WIDEN_ACTIVATION'],
    // The consensus wire-format bounds that gate selects between: canon says a change is
    // "a one-line edit here plus the byte-equal edit in the vendored copies", so lock them.
    ['price_pair_activation.js',            'PRICE_PAIR_TICKER_MAX_LEGACY'],
    ['price_pair_activation.js',            'PRICE_PAIR_TICKER_MAX_WIDE'],
    ['price_sig_tally_activation.js',       'PRICE_SIG_TALLY_ACTIVATION'],
    ['snapshot_reorg_buffer.js',           'SNAPSHOT_BURIAL_ACTIVATION'],
    // The burial depth that gate reads; canon claims it byte-identical to the local copies.
    ['snapshot_reorg_buffer.js',           'CANONICAL_REORG_BUFFER'],
];

describe('activation-gate constant parity to canonical constants.js @regression', function () {
    let canon = null;
    before(function () {
        if (!fs.existsSync(CONSTANTS_PATH)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but canonical constants not found at ' + CONSTANTS_PATH);
            this.skip();
            return;
        }
        canon = require(CONSTANTS_PATH);
    });

    GATES.forEach(function ([file, exportName]) {
        it(file + ' ' + exportName + ' is value-identical to xchain-documentation/protocol/constants.js', function () {
            const local = require('../../src/' + file)[exportName];
            // Presence, not shape: the list carries scalar consensus constants as well as
            // activation maps. The checks stay so a mistyped export name cannot compare
            // undefined to undefined and pass vacuously on both sides.
            assert.ok(local !== undefined, file + ' must export ' + exportName);
            assert.ok(canon[exportName] !== undefined,
                'constants.js must export ' + exportName + ' (the canonical authority for this gate)');
            assert.deepStrictEqual(local, canon[exportName],
                file + ' has drifted from the canonical ' + exportName + ' in ' +
                'xchain-documentation/protocol/constants.js; a one-sided flag-day edit forks consensus at the boundary.');
        });
    });
});
