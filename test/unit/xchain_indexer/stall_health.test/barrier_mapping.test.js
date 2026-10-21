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
 * Unit: barrier stallReason to grace-field wiring
 *
 * Pins, by source text, which grace field each block-loop barrier keys its
 * stallClearsAt on and how (clock, height-aware, bound-aware or null), that
 * every named grace field is assigned in its owning module, and that each
 * watermark-released barrier is registered in both release paths.
 */

'use strict';

const assert = require('assert');
const {
    REMOTE_TOKEN_RETRY_STALL_REASON
} = require('../../../../src/actions/cross_chain_remote_token.js');

/*
 * Every barrier keys its stallClearsAt on ITS OWN grace field.
 *
 * The call barrier borrowed matchWatermarkGraceS long after callSyncSatisfied
 * had been decoupled onto callWatermarkGraceS. Both constants are 120s today, so
 * the emitted value was identical and no behavioural test could see the slip.
 * barrierClearsAt coerces an unknown field to grace 0, so a rename fails silently
 * too. Pin the mapping by source text, which is the only place the pairing exists.
 */
const fs   = require('fs');
const path = require('path');

const INDEXER_SRC = require('../../../helpers/indexer_class_source.js')
    .readIndexerClassSource();
// The hub-mirror client is an entry plus a directory of parts (src/hub/hub_db_sync/),
// and the fields and methods this suite reads live in the parts, so the text under
// scan is the entry and every part joined. Walked, not listed: a part added later
// carries its assignments into the scan without an edit here.
function readTreeSource(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? readTreeSource(path.join(dir, e.name))
                                     : (e.name.endsWith('.js') ? fs.readFileSync(path.join(dir, e.name), 'utf8') : '')))
        .join('\n');
}
const SYNC_ENTRY = path.resolve(__dirname, '../../../../src/hub/hub_db_sync.js');
const SYNC_SRC = fs.readFileSync(SYNC_ENTRY, 'utf8') + '\n' +
    readTreeSource(path.resolve(__dirname, '../../../../src/hub/hub_db_sync'));

// Every stall site in the block loop, literal, constant or prefixed, is read by the shared
// reader, which throws on a form it cannot resolve. Each site's stallClearsAt is the first
// one after it and before the next site, so a site that sets none reads as 'missing'.
//
// The scan reads the HEIGHT-AWARE helper as well as the plain one, because a re-keyed
// barrier still has to name which grace it would use below its activation. It does NOT
// accept a bare `barrierClearsAt` on a re-keyed reason silently: the two helper names
// are distinguished below, so dropping the height-awareness from a call site is a red
// rather than a rename that slides through.
const { stallReasonSites, countStallReasonAssignments } = require('../../../helpers/stall_reason_sites.js');
const IMPORTED_REASONS = { REMOTE_TOKEN_RETRY_STALL_REASON };
function graceWiring() {
    const pairs = [];
    const sites = stallReasonSites(INDEXER_SRC, IMPORTED_REASONS);
    for (let i = 0; i < sites.length; i++) {
        const reason = sites[i].reason;
        const stop = i + 1 < sites.length ? sites[i + 1].index : INDEXER_SRC.length;
        const clears = /this\.stallClearsAt\s*=\s*([^;]+);/.exec(INDEXER_SRC.slice(sites[i].end, stop));
        if (!clears) { pairs.push([reason, null, 'missing']); continue; }
        const expr  = clears[1];
        const plain  = /\bbarrierClearsAt\(blockTime,\s*'([A-Za-z]+)'\)/.exec(expr);
        const height = /\bbarrierClearsAtHeightAware\(blockTime,\s*'([A-Za-z]+)',\s*blockToParse\)/.exec(expr);
        // The anchor barrier reads its grace through a BOUND-aware sibling, because its
        // predicate opens at min(blockTime, horizonBound) + grace. The field name still
        // travels in the call site, which is the pairing this scan exists to pin.
        const anchor = /\banchorBarrierClearsAt\(\s*\n?\s*blockTime,\s*anchorHorizonBound,\s*blockToParse,\s*'([A-Za-z]+)'\)/.exec(expr);
        // The direct-hub-DB call barrier has no HubDbSync to read a grace off, so it
        // keys on the indexer's own resolved field through its own helper. Map it to
        // that field so this test still pins WHICH grace the barrier uses. Its helper
        // takes the block height too (row 5): null above the admission activation,
        // the clock form below it, so it is height-aware like the mirrored members.
        const direct = /\bdirectCallBarrierClearsAt\(blockTime,\s*blockToParse\)/.test(expr);
        let field = null, kind = 'null';
        if (height)      { field = height[1]; kind = 'height-aware'; }
        else if (anchor) { field = anchor[1]; kind = 'bound-aware'; }
        else if (plain)  { field = plain[1];  kind = 'clock'; }
        else if (direct) { field = 'directCallGraceS'; kind = 'height-aware'; }
        pairs.push([reason, field, kind]);
    }
    return pairs;
}

// stallReason -> [grace field, how stallClearsAt is computed], for EVERY reason in the
// file and not a filtered subset.
//
// The filter this list replaced took `graceWiring()` down to eight curated reasons, which
// left bridge_sync_barrier, policy_sync_barrier, attest_response_sync_barrier and
// bridge_proof_barrier unpinned: a new barrier, or a re-keyed one, could drop its grace
// wiring entirely and this suite stayed green. That is the exact drift the scan exists to
// catch, so the list is exhaustive: the site count is checked against every non-null
// assignment, and a new stallReason, in any form, FAILS here until it is added.
//
// 'height-aware' means the barrier was re-keyed onto the admission height watermark and
// reports NO clear instant above its activation, which is what lets a hold accumulate and
// the 900 s ceiling fire on a stall that is now genuine mirror lag.
const EXPECTED = [
    // Train-activation safety halt, read by its prefix (the tail is the verdict prose).
    ['train_activation_halt:',          null,                          'null'],
    ['price_sync_barrier',              null,                          'null'],          // height case can clear early
    ['price_sync_barrier',              'priceWatermarkGraceS',        'height-aware'],
    ['price_landing_barrier',           null,                          'null'],          // clears on other chains' landed time
    ['oracle_sync_barrier',             'oracleWatermarkGraceS',       'height-aware'],
    ['match_sync_barrier',              'matchWatermarkGraceS',        'height-aware'],
    ['call_sync_barrier',               'callWatermarkGraceS',         'height-aware'],
    ['bridge_sync_barrier',             'bridgeWatermarkGraceS',       'height-aware'],
    ['policy_sync_barrier',             'policyWatermarkGraceS',       'height-aware'],
    ['list_share_sync_barrier',         null,                          'null'],
    ['remote_token_retry_barrier',      null,                          'null'],          // action-scoped height retry
    // Direct-hub-DB twin of call_sync_barrier. A null here (no watermark to key on)
    // is what makes such a barrier wedge forever: it leaves no time-keyed escape at
    // all. This one has one, resolved onto the indexer from the SAME frozen call
    // grace hub_db_sync uses.
    ['call_presence_barrier',           'directCallGraceS',            'height-aware'],
    ['anchor_attest_barrier',           'anchorAttestWatermarkGraceS', 'bound-aware'],
    ['attest_response_sync_barrier',    'attestResponseWatermarkGraceS', 'height-aware'],
    ['capability_proof_unavailable',    null,                          'null'],          // proof verification, not wall clock
    ['snapshot_sync_barrier',           null,                          'null'],          // presence, not wall clock
    // Host faults, not mirror barriers: none of them has a clock instant to name, and a
    // grace field appearing on one would be a category error rather than a drift.
    ['vm_executor_unavailable',         null,                          'null'],
    ['anchor_reward_proof_unavailable', null,                          'null'],
    ['bridge_proof_barrier',            null,                          'null'],
    ['rollcall_proof_unavailable',      null,                          'null'],
    ['list_share_snapshot_barrier',     null,                          'null'],
    ['list_share_halt',                 null,                          'null'],
    ['parse_exception:',                null,                          'null']          // repeated parse failure, by prefix
];
describe('barrier stallClearsAt grace-field mapping @regression', function () {

    it('each barrier keys stallClearsAt on its own grace field', function () {
        assert.strictEqual(stallReasonSites(INDEXER_SRC, IMPORTED_REASONS).length,
            countStallReasonAssignments(INDEXER_SRC),
            'a non-null stallReason assignment is outside the scan; extend stall_reason_sites.js to read it');
        assert.deepStrictEqual(graceWiring(), EXPECTED,
            'barrier-to-grace wiring drifted. Borrowing a sibling barrier\'s grace ' +
            'mis-times the /status wedge discriminator the moment the two constants ' +
            'diverge or a regtest env override moves one, and both are 120s today so ' +
            'no behavioural assertion can see the slip. A re-keyed barrier that lost its ' +
            'height-aware helper reads as a clock barrier here, which is the other half.');
    });

    it('every re-keyed barrier reports NO clear instant above the admission activation', function () {
        // The height half reads no t(B) and can open the barrier at any instant, so there is no
        // first instant to report; the stream escape five of them keep is a later backstop,
        // not a floor. Reporting one anyway keeps waitingOnFutureBlock() answering
        // 'future_block_wait', keeps nextBarrierHold() at null and makes the 900 s ceiling
        // unreachable on exactly the barrier whose stall is now remediable.
        const reKeyed = EXPECTED.filter(e => e[2] === 'height-aware' || e[2] === 'bound-aware');
        assert.strictEqual(reKeyed.length, 9,
            'nine EXPECTED entries are re-keyed onto a height (height-aware or bound-aware); ' +
            'a change here means a barrier gained or lost its height keying');
        assert.ok(/\bbarrierClearsAtHeightAware\(blockTime, graceField, blockHeight\)\{[\s\S]{0,400}?\bmirrorAdmissionActiveAt\(blockHeight\)\) return null;/.test(INDEXER_SRC),
            'the height-aware helper must return null while the admission consumer is armed');
        assert.ok(/\banchorBarrierClearsAt\(blockTime, horizonBound, blockHeight, graceField\)\{[\s\S]{0,400}?\bmirrorAdmissionActiveAt\(blockHeight\)\) return null;/.test(INDEXER_SRC),
            'the anchor barrier\'s bound-aware helper must return null while the admission consumer is armed');
    });
});
describe('barrier stallClearsAt grace-field mapping @regression', function () {

    it('every grace field named by a barrier exists on the HubDbSync instance', function () {
        // barrierClearsAt coerces an unresolvable field to grace 0, so a rename that
        // misses a call site degrades silently rather than throwing.
        for (const [reason, field] of EXPECTED) {
            if (field === null) continue;
            // directCallGraceS lives on the indexer, not on HubDbSync: the direct barrier
            // runs precisely when there is no HubDbSync instance to read one off.
            const src = (field === 'directCallGraceS') ? INDEXER_SRC : SYNC_SRC;
            // The parts set instance fields through the constructor's `sync` argument
            // (src/hub/hub_db_sync/watermark_state.js), the indexer through `this`.
            assert.ok(new RegExp('(?:this|sync)\\.' + field + '\\s*=').test(src),
                field + ' (used by ' + reason + ') is not assigned in its owning module');
        }
    });

    it('the direct call barrier resolves its grace from the frozen call constant', function () {
        // The whole point of the escape is that the direct path and the mirrored path
        // open on the SAME number. A private default here, or a resolver that skips
        // resolveWatermarkGrace, would let two operators of one chain inject a cross-chain
        // call at different blocks.
        assert.ok(/resolveWatermarkGrace\(\s*\n?\s*HUB_SYNC_WATERMARK_GRACE_S\.call,\s*'HUB_SYNC_CALL_GRACE_S'/.test(INDEXER_SRC),
            'directCallGraceS must be resolved through hub_db_sync resolveWatermarkGrace on the frozen call grace');
        // Attached to the class before the one `module.exports = HubDbSync`, so the
        // consumer's `require(...).resolveWatermarkGrace` is exactly that assignment.
        assert.ok(/\bHubDbSync\.resolveWatermarkGrace\s*=/.test(SYNC_SRC),
            'hub_db_sync must export resolveWatermarkGrace for the direct barrier to share it');
    });
});

// Curated, with every other `release*Waiters` definition named in RELEASED_ELSEWHERE:
// those waiters are released off their own event instead of the watermark, so a blanket
// "every waiter method fires here" rule would be wrong on its face. A barrier missing
// from advanceWatermark blocks its waiters for the full poll timeout on every advance.
const REQUIRED_WATERMARK_RELEASES = [
    'releasePriceWaiters',
    'releasePriceTimeWaiters',
    'releaseOracleWaiters',
    'releaseMatchWaiters',
    'releaseCallWaiters',
    'releaseBridgeWaiters',
    'releasePolicyWaiters',
    'releaseListShareWaiters',
    'releaseRemoteTokenWaiters',
    'releaseAnchorAttestWaiters',
    'releaseAttestResponseWaiters',
];
const RELEASED_ELSEWHERE = Object.freeze({
    releaseSnapshotWaiters:        'the CROSS_CHAIN_TABLES content refresh',
    releaseLandingWaiters:         'the price-landing advance',
    releaseCapabilityProofWaiters: 'the capability-proof verdict',
});
// Every release*Waiters method the entry and its parts define, bar the height release path.
function definedWaiterReleases(src) {
    const names = new Set();
    for (const m of src.matchAll(/^\s*(?:async\s+)?(release[A-Za-z]+Waiters)\s*\(\s*\)\s*\{/gm)) names.add(m[1]);
    names.delete('releaseHeightWaiters');
    return [...names].sort();
}
describe('barrier stallClearsAt grace-field mapping @regression', function () {

    it('every curated barrier registers its release call inside _advanceWatermark', function () {
        // Fails a new waiter family until it is curated or excepted, and a stale listed name.
        assert.deepStrictEqual(definedWaiterReleases(SYNC_SRC),
            REQUIRED_WATERMARK_RELEASES.concat(Object.keys(RELEASED_ELSEWHERE)).sort(),
            'each release*Waiters definition belongs in REQUIRED_WATERMARK_RELEASES or RELEASED_ELSEWHERE');
        const m = /advanceWatermark\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(SYNC_SRC);
        assert.ok(m, 'advanceWatermark method not found in the hub_db_sync entry or its parts');
        const body = m[1];
        for (const call of REQUIRED_WATERMARK_RELEASES) {
            assert.ok(body.includes(call + '('),
                call + '() is missing from advanceWatermark; its waiters would block for the full poll timeout on every advance');
        }
    });
});
describe('barrier stallClearsAt grace-field mapping @regression', function () {

    // Above the activation the HEIGHT watermark is what satisfies those same waiters, and it
    // moves on frames whose `ts` did not. A barrier missing from the height release path
    // therefore sits out its whole 60 s timeout on every height advance, which is the same
    // defect as the one above on the axis the family actually opens on.
    it('every curated barrier registers its release call inside _releaseHeightWaiters', function () {
        const m = /releaseHeightWaiters\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(SYNC_SRC);
        assert.ok(m, 'releaseHeightWaiters method not found in the hub_db_sync entry or its parts');
        const body = m[1];
        for (const call of REQUIRED_WATERMARK_RELEASES) {
            assert.ok(body.includes(call + '('),
                call + '() is missing from releaseHeightWaiters; its waiters would block for the full poll timeout on every height advance');
        }
    });
});
