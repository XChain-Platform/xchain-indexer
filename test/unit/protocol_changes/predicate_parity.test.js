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

// Predicate parity (activation-registry D69): at W3 every module keeps its own
// predicate body and reads its table through the registry; W4 replaces those
// predicates with the one generic activeAt(). This suite is the proof that the
// replacement is behaviour-preserving, row by row, BEFORE it happens: every
// predicate against activeAt() at the neighbours of every committed threshold,
// at the UNARMED sentinel, on a null (UNPINNED) entry and on an unknown network.
//
// A predicate that differs is a FINDING, not an edit: it tells W4 what
// activeAt() has to learn (or which predicate has to stay). The findings are
// pinned below, so a new divergence and a resolved one both surface here.

const assert = require('assert');
const ProtocolChanges = require('../../../src/protocol_changes.js');
const { TABLE, compareAll } = require('./helpers/predicate_parity.js');

// Gate rows the table cannot compare, and why.
const SKIPPED = {
    'attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION':
        'no boolean predicate: widenSlots(atBlock, requestBlock, deadlineBlock, network) returns a slot count',
    'train_activation.TRAIN_ACTIVATION':
        'ruleset unit: resolveRuleSet(height, network) returns a version and activeAt() throws unsupported unit; W4 needs a ruleSetAt() reader',
    'protocol/constants.STAKE_WEIGHTED_QUORUM_ACTIVATION': 'documentation mirror row, no predicate in that file',
    'protocol/constants.EQUIV_HEADER_ACTIVATION': 'documentation mirror row, no predicate in that file',
    'protocol/constants.STATE_COMMITMENT_ACTIVATION': 'documentation mirror row, no predicate in that file',
    'protocol/constants.CHECKPOINT_COMMITMENT_ACTIVATION': 'documentation mirror row, no predicate in that file',
    'protocol/constants.ANCHOR_REWARD_ACTIVATION': 'documentation mirror row, no predicate in that file',
    'protocol/constants.ARCHIVE_REWARD_ACTIVATION': 'documentation mirror row, no predicate in that file',
    'protocol/constants.CROSS_CHAIN_ROYALTY_ACTIVATION': 'documentation mirror row, no predicate in that file',
};

// The predicates measured to differ from activeAt(), with the first differing
// input each, as found 2026-09-15 (the lane report of row 12 carries the same).
const FINDINGS = {
    'oracle_preload_causality_activation.ORACLE_PRELOAD_CAUSALITY_ACTIVATION':
        'the predicate answers false for the reference coin (BTC) at every height; the exclusion lives in the body, not the table',
    'price_batching_floor_activation.PRICE_BATCHING_FLOOR_ACTIVATION':
        'a floor, not a gate: isPriceBarrierRequired() answers true for an unknown network and any unevaluable input, where activeAt() answers false',
};

describe('protocol_changes/predicate_parity: every gate predicate against activeAt() @regression @tier1', function () {
    let results;
    before(function () { results = compareAll(); });

    it('the table names every height, time and epoch row once, or the row is listed as skipped', function () {
        const gateKeys = ProtocolChanges.rows().map(([k]) => k)
            .filter((k) => ['height', 'time', 'epoch', 'ruleset'].includes(ProtocolChanges.registry.unitOf(k)));
        const tabled = TABLE.map(([k]) => k);
        assert.strictEqual(new Set(tabled).size, tabled.length, 'a key is tabled twice');
        const covered = new Set(tabled.concat(Object.keys(SKIPPED)));
        assert.deepStrictEqual(gateKeys.filter((k) => !covered.has(k)), [], 'gate rows with no parity case');
        assert.deepStrictEqual(tabled.filter((k) => !gateKeys.includes(k)), [], 'tabled keys that are not gate rows');
        assert.deepStrictEqual(Object.keys(SKIPPED).filter((k) => tabled.includes(k)), [], 'skipped and tabled');
    });

    it('every predicate is EQUAL to activeAt() on every sampled input, except the pinned findings', function () {
        const differing = results.filter((r) => r.verdict !== 'EQUAL');
        const report = differing.map((r) => r.key + ' ' + r.verdict + ' at ' + JSON.stringify(r.first)).join('\n');
        assert.deepStrictEqual(differing.map((r) => r.key).sort(), Object.keys(FINDINGS).sort(),
            'the set of differing predicates moved; re-read the findings:\n' + report);
        for (const r of results) assert.ok(r.inputs >= 5, r.key + ' compared only ' + r.inputs + ' inputs');
        assert.ok(results.filter((r) => r.verdict === 'EQUAL').length >= 70, 'too few predicates compared');
    });

    it('the two findings differ for the recorded reason, not for a moved threshold', function () {
        const byKey = new Map(results.map((r) => [r.key, r]));
        const preload = byKey.get('oracle_preload_causality_activation.ORACLE_PRELOAD_CAUSALITY_ACTIVATION');
        assert.strictEqual(preload.first.coin, 'BTC');
        assert.strictEqual(preload.first.predicate, false);
        assert.strictEqual(preload.first.activeAt, true);
        const floor = byKey.get('price_batching_floor_activation.PRICE_BATCHING_FLOOR_ACTIVATION');
        assert.strictEqual(floor.first.network, 'devnet');
        assert.strictEqual(floor.first.predicate, true);
        assert.strictEqual(floor.first.activeAt, false);
    });

    it('activeAt() refuses the ruleset row rather than guessing a version', function () {
        assert.throws(() => ProtocolChanges.activeAt('train_activation.TRAIN_ACTIVATION', 'mainnet', null, 0, 0), /unsupported unit ruleset/);
    });
});
