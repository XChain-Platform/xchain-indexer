/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The due-set trim for by-reference policy snapshots: a reference at some policy_seq holds back
 * that seq and every later one of the same (origin_chain, tick), and nothing else.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { dropRefRowsFromFirst } = require('../../../../src/consensus/bridge_settle/policy_ref_due.js');
const { SETTLE_REASON } = require('../../../../src/consensus/bridge_settle/reasons.js');

const row = (origin_chain, tick, policy_seq, ref) => ({ origin_chain, tick, policy_seq, ref });
const id = (r) => r.origin_chain + r.tick + r.policy_seq;
const carries = (r) => r.ref;

describe('dropRefRowsFromFirst', () => {
    it('keeps seq 1 and drops seqs 2 and 3 when seq 2 carries a ref', () => {
        const out = dropRefRowsFromFirst([
            row('DOGE', 'A', 1, false), row('DOGE', 'A', 2, true), row('DOGE', 'A', 3, false),
        ], carries);
        assert.deepStrictEqual(out.map(id), ['DOGEA1']);
    });

    it('leaves another tick and another origin chain untouched', () => {
        const out = dropRefRowsFromFirst([
            row('DOGE', 'A', 2, true), row('DOGE', 'B', 3, false), row('LTC', 'A', 3, false),
        ], carries);
        assert.deepStrictEqual(out.map(id), ['DOGEB3', 'LTCA3']);
    });

    it('preserves the given order', () => {
        const out = dropRefRowsFromFirst([
            row('LTC', 'A', 5, false), row('DOGE', 'A', 1, false), row('DOGE', 'B', 2, false),
            row('DOGE', 'A', 2, true), row('DOGE', 'A', 3, false),
        ], carries);
        assert.deepStrictEqual(out.map(id), ['LTCA5', 'DOGEA1', 'DOGEB2']);
    });

    it('drops the whole group when the ref is at the lowest seq', () => {
        const out = dropRefRowsFromFirst([
            row('DOGE', 'A', 1, true), row('DOGE', 'A', 2, false), row('DOGE', 'A', 3, true),
        ], carries);
        assert.deepStrictEqual(out, []);
    });

    it('uses the lowest ref seq regardless of input order', () => {
        const out = dropRefRowsFromFirst([
            row('DOGE', 'A', 4, true), row('DOGE', 'A', 2, true), row('DOGE', 'A', 1, false), row('DOGE', 'A', 3, false),
        ], carries);
        assert.deepStrictEqual(out.map(id), ['DOGEA1']);
    });

    it('returns a copy of a group-free input and never mutates it', () => {
        const rows = [row('DOGE', 'A', 1, false), row('DOGE', 'A', 2, true), row('DOGE', 'A', 3, false)];
        const snapshot = JSON.stringify(rows);
        const out = dropRefRowsFromFirst(rows, carries);
        assert.strictEqual(JSON.stringify(rows), snapshot);
        assert.strictEqual(rows.length, 3);
        assert.notStrictEqual(out, rows);

        const plain = [row('DOGE', 'A', 1, false)];
        const copy = dropRefRowsFromFirst(plain, carries);
        assert.deepStrictEqual(copy, plain);
        assert.notStrictEqual(copy, plain);
    });

    it('throws a TypeError on bad arguments', () => {
        assert.throws(() => dropRefRowsFromFirst('x', carries), TypeError);
        assert.throws(() => dropRefRowsFromFirst([], null), TypeError);
    });
});

describe('policy ref settle reasons', () => {
    it('exist with distinct text', () => {
        assert.strictEqual(typeof SETTLE_REASON.POLICY_REF_PENDING, 'string');
        assert.strictEqual(typeof SETTLE_REASON.POLICY_REF_BEFORE_CONSUMER, 'string');
        assert.notStrictEqual(SETTLE_REASON.POLICY_REF_PENDING, SETTLE_REASON.POLICY_REF_BEFORE_CONSUMER);
    });
});
