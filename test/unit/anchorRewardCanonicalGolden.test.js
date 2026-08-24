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
 * test/unit/anchorRewardCanonicalGolden.test.js
 *
 * CONSENSUS REGRESSION GUARD for the THIRD copy of the XANCPUB reward canonical.
 *
 * The same signed string is built in three independent places:
 *   1. xchain-hub/src/StateAnchorPublisher.js  _attestationCanonical / _archiveAttestationCanonical
 *   2. xchain-indexer/src/actions/anchor.js    Anchor.prototype._rewardCanonical  (DOGE wire-parse side)
 *   3. xchain-indexer/src/anchor_reward_derive.js  rewardCanonical(row)           (BTC mirror re-derivation)
 *
 * Copies 1 and 2 are byte-compared against each other and against these same
 * literals by xchain-e2e-test/test/integration/parity/anchorRewardParity.test.js.
 * Copy 3 was pinned by nothing: anchorRewardDerive.test.js signs its fixtures with
 * derive.rewardCanonical's OWN output, so a one-sided edit to the join order, the
 * EQUIV round-id family, or the chain-case handling re-signs itself and every
 * assertion in that file still passes - while the re-verified quorum on the BTC side
 * would never match and the reward would silently never derive, fleet-wide.
 *
 * The literals below are the FROZEN wire format (ANCHOR.md, publisher-attestation
 * canonical), the same strings the cross-service parity suite pins the other two
 * copies to. They live here, in the indexer's own suite, deliberately: an
 * indexer-only change never runs the e2e repo's suite, which is exactly the branch
 * that would introduce the drift. Changing any of these strings is a flag-day.
 */

'use strict';

const assert = require('assert');
const derive = require('../../src/anchor_reward_derive.js');
const ar     = require('../../src/anchor_reward_activation.js');
const eq     = require('../../src/equivocation_header.js');

const PUBLISHER = '07'.repeat(32);

// One mirrored anchor_reward_attestations row, in the shape rewardCanonical() reads.
function row(over) {
    return Object.assign({
        reward_type:     'anchor_BTC',
        round_reference: 7,
        snapshot_block:  100,
        publisher:       PUBLISHER,
        network:         'regtest'
    }, over || {});
}

describe('XANCPUB reward canonical: derive copy vs the frozen wire format @regression @tier1', function () {

    // regtest EQUIV_HEADER_ACTIVATION is 0, so snapshot_block 100 is header-bearing;
    // mainnet is 961000, so snapshot_block 1000 is header-less. Asserted rather than
    // assumed, so a flag-day re-pin cannot quietly turn these four cases into two.
    it('exercises both flag-day sides (the fixtures straddle the EQUIV header activation)', function () {
        assert.strictEqual(eq.isEquivHeaderActive(100, 'regtest'), true,
            'regtest@100 must be EQUIV-active or the post-flag-day cases below prove nothing');
        assert.strictEqual(eq.isEquivHeaderActive(1000, 'mainnet'), false,
            'mainnet@1000 must be EQUIV-dormant or the pre-flag-day cases below prove nothing');
    });

    it('post-flag-day per-chain: EQUIV-wrapped, frozen ANCHOR amount', function () {
        assert.strictEqual(derive.rewardCanonical(row()),
            'EQUIV|XCHECKPOINT|XANCPUB|BTC|regtest|7|100|0||XANCPUB|anchor_BTC|7|100|' +
            PUBLISHER + '|10.00000000',
            'anchor_reward_derive.rewardCanonical drifted from the frozen XANCPUB wire format');
    });

    it('pre-flag-day per-chain: the bare XANCPUB string, no EQUIV prefix', function () {
        const c = derive.rewardCanonical(row({ snapshot_block: 1000, network: 'mainnet' }));
        assert.strictEqual(c,
            'XANCPUB|anchor_BTC|7|1000|' + PUBLISHER + '|10.00000000',
            'pre-flag-day per-chain canonical drifted from the frozen wire format');
        assert.ok(!c.startsWith('EQUIV|'), 'pre-flag-day canonical must carry no EQUIV prefix');
    });

    it('post-flag-day archive: EQUIV-wrapped, archive round-id family, frozen ARCHIVE amount', function () {
        assert.strictEqual(derive.rewardCanonical(row({ reward_type: 'anchor_archive', round_reference: 3 })),
            'EQUIV|XCHECKPOINT|XANCPUB|archive|regtest|3|100|0||XANCPUB|anchor_archive|3|100|' +
            PUBLISHER + '|10.00000000',
            'archive XANCPUB canonical drifted from the frozen wire format');
    });

    it('pre-flag-day archive: the bare archive XANCPUB string', function () {
        assert.strictEqual(
            derive.rewardCanonical(row({ reward_type: 'anchor_archive', round_reference: 3,
                                         snapshot_block: 1000, network: 'mainnet' })),
            'XANCPUB|anchor_archive|3|1000|' + PUBLISHER + '|10.00000000',
            'pre-flag-day archive canonical drifted from the frozen wire format');
    });

    it('ends on the frozen consensus amount, never a wire value', function () {
        assert.ok(derive.rewardCanonical(row()).endsWith('|' + ar.ANCHOR_REWARD_AMOUNT),
            'per-chain canonical must end with the frozen ANCHOR_REWARD_AMOUNT');
        assert.ok(derive.rewardCanonical(row({ reward_type: 'anchor_archive', round_reference: 3 }))
                        .endsWith('|' + ar.ARCHIVE_REWARD_AMOUNT),
            'archive canonical must end with the frozen ARCHIVE_REWARD_AMOUNT');
    });

    it('the archive and per-chain EQUIV round-id families stay disjoint', function () {
        // Same seq, same snapshot: signing both must not look like an equivocation.
        const perChain = derive.rewardCanonical(row({ round_reference: 3 }));
        const archive  = derive.rewardCanonical(row({ reward_type: 'anchor_archive', round_reference: 3 }));
        const roundIdOf = (s) => s.split('||')[0];
        assert.notStrictEqual(roundIdOf(perChain), roundIdOf(archive),
            'archive round id must not collide with the per-chain XANCPUB round id');
    });

    // Load-bearing and, until now, asserted nowhere: this copy takes the chain VERBATIM
    // out of reward_type (`String(row.reward_type).slice('anchor_'.length)`), while
    // Anchor.prototype._rewardCanonical upper-cases d.CHAIN. The two agree only because
    // every mirrored row carries an uppercase chain (see the invariant note in
    // src/reward-push-gate.js). If that ever stops holding, the strings fork silently.
    //
    // This test is NOT a request to normalize the case here: doing so would alter a
    // signed-string derivation, which is a protocol decision and a flag-day, not test
    // hygiene. It exists to make any such change a conscious one.
    it('takes the chain verbatim from reward_type, so mirror rows MUST carry it uppercase', function () {
        const upper = derive.rewardCanonical(row());
        const lower = derive.rewardCanonical(row({ reward_type: 'anchor_btc' }));
        assert.notStrictEqual(lower, upper,
            'a lowercase reward_type must NOT silently produce the uppercase canonical');
        assert.ok(lower.includes('|anchor_btc|'),
            'the case is carried through verbatim; normalizing it here is a flag-day, not a test fix');
        assert.ok(lower.includes('|XANCPUB|btc|'),
            'the EQUIV round-id family also carries the chain verbatim, so it forks with it');
    });
});
