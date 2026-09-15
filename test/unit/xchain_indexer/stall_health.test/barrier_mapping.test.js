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
 * Unit: stallWedged() /status healthcheck discriminator
 *
 * The height-keyed BTC price-sync barrier defers the newest block on almost
 * every poll, so a healthy BTC-mainnet indexer is nearly always mid-barrier
 * (stallReason set) even though it advances every few seconds. stallWedged()
 * is what lets the container /status healthcheck reserve 503 for a real wedge
 * rather than restart-looping a functioning service.
 */

'use strict';

const assert = require('assert');

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

// Every `this.stallReason = '<name>';` in the block loop is immediately followed by
// the matching `this.stallClearsAt = ...;`, so a non-greedy pair scan reads the
// wiring exactly rather than guessing at a line window.
//
// The scan reads the HEIGHT-AWARE helper as well as the plain one, because a re-keyed
// barrier still has to name which grace it would use below its activation. It does NOT
// accept a bare `barrierClearsAt` on a re-keyed reason silently: the two helper names
// are distinguished below, so dropping the height-awareness from a call site is a red
// rather than a rename that slides through.
function graceWiring() {
    const pairs = [];
    const re = /this\.stallReason = '(\w+)';[\s\S]*?this\.stallClearsAt\s*=\s*([^;]+);/g;
    let m;
    while ((m = re.exec(INDEXER_SRC)) !== null) {
        const expr  = m[2];
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
        pairs.push([m[1], field, kind]);
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
// catch, so the list is now exhaustive and a new stallReason FAILS here until it is added.
//
// 'height-aware' means the barrier was re-keyed onto the admission height watermark and
// reports NO clear instant above its activation, which is what lets a hold accumulate and
// the 900 s ceiling fire on a stall that is now genuine mirror lag.
const EXPECTED = [
    ['price_sync_barrier',              null,                          'null'],          // height case can clear early
    ['price_sync_barrier',              'priceWatermarkGraceS',        'height-aware'],
    ['oracle_sync_barrier',             'oracleWatermarkGraceS',       'height-aware'],
    ['match_sync_barrier',              'matchWatermarkGraceS',        'height-aware'],
    ['call_sync_barrier',               'callWatermarkGraceS',         'height-aware'],
    ['bridge_sync_barrier',             'bridgeWatermarkGraceS',       'height-aware'],
    ['policy_sync_barrier',             'policyWatermarkGraceS',       'height-aware'],
    // Direct-hub-DB twin of call_sync_barrier. A null here (no watermark to key on)
    // is what makes such a barrier wedge forever: it leaves no time-keyed escape at
    // all. This one has one, resolved onto the indexer from the SAME frozen call
    // grace hub_db_sync uses.
    ['call_presence_barrier',           'directCallGraceS',            'height-aware'],
    ['anchor_attest_barrier',           'anchorAttestWatermarkGraceS', 'bound-aware'],
    ['attest_response_sync_barrier',    'attestResponseWatermarkGraceS', 'height-aware'],
    ['snapshot_sync_barrier',           null,                          'null'],          // presence, not wall clock
    // Host faults, not mirror barriers: none of them has a clock instant to name, and a
    // grace field appearing on one would be a category error rather than a drift.
    ['vm_executor_unavailable',         null,                          'null'],
    ['anchor_reward_proof_unavailable', null,                          'null'],
    ['bridge_proof_barrier',            null,                          'null'],
    ['rollcall_proof_unavailable',      null,                          'null']
];
describe('barrier stallClearsAt grace-field mapping @regression', function () {

    it('each barrier keys stallClearsAt on its own grace field', function () {
        assert.deepStrictEqual(graceWiring(), EXPECTED,
            'barrier-to-grace wiring drifted. Borrowing a sibling barrier\'s grace ' +
            'mis-times the /status wedge discriminator the moment the two constants ' +
            'diverge or a regtest env override moves one, and both are 120s today so ' +
            'no behavioural assertion can see the slip. A re-keyed barrier that lost its ' +
            'height-aware helper reads as a clock barrier here, which is the other half.');
    });

    it('every re-keyed barrier reports NO clear instant above the admission activation', function () {
        // The height rule removes t(B) from the predicate, so there is no instant wall clock
        // can reach that opens it. Reporting one anyway keeps waitingOnFutureBlock() answering
        // 'future_block_wait', keeps nextBarrierHold() at null and makes the 900 s ceiling
        // unreachable on exactly the barrier whose stall is now remediable.
        const reKeyed = EXPECTED.filter(e => e[2] === 'height-aware' || e[2] === 'bound-aware');
        assert.strictEqual(reKeyed.length, 9, 'nine of the eleven hold points are re-keyed onto a height');
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

// Curated, not derived from every `_release*Waiters` definition:
// releaseSnapshotWaiters is deliberately driven off the CROSS_CHAIN_TABLES
// content refresh instead of the watermark, so a blanket "every waiter
// method fires here" rule would be wrong on its face. A barrier missing
// from advanceWatermark blocks its waiters for the full poll timeout on
// every advance.
const REQUIRED_WATERMARK_RELEASES = [
    'releasePriceWaiters',
    'releasePriceTimeWaiters',
    'releaseOracleWaiters',
    'releaseMatchWaiters',
    'releaseCallWaiters',
    'releaseAnchorAttestWaiters',
    'releaseAttestResponseWaiters',
];
describe('barrier stallClearsAt grace-field mapping @regression', function () {

    it('every curated barrier registers its release call inside _advanceWatermark', function () {
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
