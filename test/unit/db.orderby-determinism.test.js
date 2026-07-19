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
 * test/unit/db.orderby-determinism.test.js
 *
 * CONSENSUS REGRESSION GUARD (hotspot invariant, ): every ORDER BY in
 * src/db.js must impose a deterministic total order.
 *
 * WHY THIS EXISTS: src/db.js is the platform's #1 fix-commit hotspot (the review
 * defect-recurrence monitor flagged ~55 distinct fixes in 90 days). The single
 * most-repeated defect shape in that history is a consensus read whose ORDER BY
 * ranks rows by a NON-unique column with no unique tiebreaker, so MariaDB is free
 * to return equal-ranked rows in engine-arbitrary order. When such a query feeds a
 * hash, a LIMIT/cap, or any order-sensitive block-processing step, two honest nodes
 * on the same canonical chain diverge. The recurring fixes each append a unique
 * tiebreaker (action_index / id / pubkey / round_number / ...); commits d32ee4b,
 * 2b25105, 6dce466, 458b59a and 7a21579 are examples, and the per-method siblings
 * db.getStakers-tieorder / db.getHolders-tiebreak / db.getBlockHashes-tieorder
 * guard individual instances behaviorally.
 *
 * This test locks the whole class structurally: it parses every SQL string literal
 * in db.js and asserts each ORDER BY clause carries at least one column from the
 * recognized tiebreaker set, OR is enumerated in ALLOWLIST with a determinism
 * rationale. A newly-added `ORDER BY <non-unique-col>` with no tiebreaker fails here
 * until the author adds a tiebreaker or justifies the exception. Teeth are proven by
 * a negative control; allowlist rot is prevented by a freshness check.
 *
 * SCOPE / limits: this is a source-static ratchet, not a semantic proof. It scans
 * strings only (comments and prose can never trip it), and checks for the PRESENCE
 * of a tiebreaker token anywhere in the order clause rather than proving column
 * uniqueness. It cannot catch ordering by a contextually-non-unique column that is
 * nonetheless in the recognized set; those subtle cases stay covered by the
 * behavioral per-method tie-order tests. Its job is to stop the dominant, blunt
 * "no tiebreaker at all" regression from ever landing silently again.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'src', 'db.js');

// Columns that (as an ORDER BY term, in the context they appear in db.js) impose or
// complete a deterministic total order. Per-row-unique keys (action_index, id,
// tx_index, call_id, match_id) plus canonical/aggregation-unique keys that the
// recurring determinism fixes settled on as the accepted tiebreakers.
const TIEBREAKERS = [
    'action_index', 'tx_index', 'call_id', 'match_id', 'option_index',
    'chunk_index', 'execution_index', 'position', 'round_number', 'pubkey',
    'tick', 'source', 'state_key', 'address', 'epoch_height', 'vout',
    'seq_in_index', 'index_name', 'name'
];

// Order clauses that legitimately carry NO tiebreaker column, each with the reason
// its ordering is still deterministic. Keyed by the whitespace-normalized clause
// text (line-independent so it survives edits elsewhere in the file). Adding an
// entry here is a deliberate, reviewed act.
const ALLOWLIST = [
    {
        clause: 'block_index ASC',
        reason: 'getTimeWeightedBalances: per-address signed-delta accumulation where ' +
                'same-block events form zero-length segments, so intra-block order cannot ' +
                'change the time-weighted result (documented at the call site).'
    },
    {
        clause: 'a2.action',
        reason: 'market action-type counts: paired with GROUP BY a2.action, so a2.action ' +
                'is unique per returned row (a total order by construction).'
    }
];

// Extract SQL-bearing string literals from JS source. Backtick templates span
// newlines (multi-line SQL); single/double-quoted strings reset at a newline (JS
// forbids raw newlines in them), which self-heals any tokenizer desync within a
// line. Comments are skipped entirely, so ORDER BY appearing in prose is invisible.
function stringLiterals(s) {
    const res = [];
    let i = 0; const n = s.length; let state = 'code';
    let buf = '';
    const flush = () => { if (buf) res.push(buf); buf = ''; };
    while (i < n) {
        const c = s[i], d = s[i + 1];
        if (state === 'code') {
            if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
            if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
            if (c === '`') { state = 'tpl'; buf = ''; i++; continue; }
            if (c === "'") { state = 'sq'; buf = ''; i++; continue; }
            if (c === '"') { state = 'dq'; buf = ''; i++; continue; }
            i++; continue;
        }
        if (state === 'line')  { if (c === '\n') state = 'code'; i++; continue; }
        if (state === 'block') { if (c === '*' && d === '/') { state = 'code'; i += 2; continue; } i++; continue; }
        if (state === 'tpl') {
            if (c === '\\') { buf += c + (d || ''); i += 2; continue; }
            if (c === '`')  { flush(); state = 'code'; i++; continue; }
            buf += c; i++; continue;
        }
        if (state === 'sq') {
            if (c === '\\') { buf += c + (d || ''); i += 2; continue; }
            if (c === '\n' || c === "'") { flush(); state = 'code'; i++; continue; }
            buf += c; i++; continue;
        }
        if (state === 'dq') {
            if (c === '\\') { buf += c + (d || ''); i += 2; continue; }
            if (c === '\n' || c === '"') { flush(); state = 'code'; i++; continue; }
            buf += c; i++; continue;
        }
    }
    return res;
}

// Every ORDER BY clause across a set of SQL literals, whitespace-normalized. Each
// clause is bounded by the next LIMIT / ORDER BY / statement end so one clause
// cannot swallow a later one.
function orderByClauses(literals) {
    const out = [];
    for (const lit of literals) {
        const re = /ORDER\s+BY\s+([\s\S]*?)(?=\s+LIMIT\b|ORDER\s+BY|;|$)/gi;
        let m;
        while ((m = re.exec(lit)) !== null) {
            const clause = m[1].replace(/\s+/g, ' ').trim();
            if (clause) out.push(clause);
        }
    }
    return out;
}

// Whole-word column presence (so `address_id` does NOT satisfy `id`, and `source`
// does not match inside `source_id`).
function hasWord(clause, col) {
    return new RegExp('(^|[^a-z0-9_])' + col + '([^a-z0-9_]|$)', 'i').test(clause);
}

function hasTiebreaker(clause) {
    if (hasWord(clause, 'id')) return true;
    for (const t of TIEBREAKERS) if (hasWord(clause, t)) return true;
    return false;
}

const allowSet = new Set(ALLOWLIST.map(a => a.clause));

describe('src/db.js ORDER BY determinism (consensus hotspot invariant) @regression @tier1', function () {

    const source    = fs.readFileSync(DB_PATH, 'utf8');
    const literals  = stringLiterals(source);
    const clauses   = orderByClauses(literals);

    // Sanity: we actually parsed a substantial body of SQL. Guards against a parser
    // change silently reducing coverage to zero (a vacuous green).
    it('parses a non-trivial population of ORDER BY clauses from db.js', function () {
        assert.ok(clauses.length >= 80,
            'expected to find many ORDER BY clauses in db.js; found ' + clauses.length +
            ' - the SQL-literal parser likely regressed');
    });

    // The invariant: no order clause may rank rows without a deterministic tiebreaker.
    it('every ORDER BY carries a recognized tiebreaker or a documented allowlist exception', function () {
        const offenders = [];
        for (const clause of clauses) {
            if (hasTiebreaker(clause)) continue;
            if (allowSet.has(clause)) continue;
            offenders.push(clause);
        }
        assert.deepStrictEqual(offenders, [],
            'ORDER BY clause ranks rows with no recognized unique tiebreaker column ' +
            '(engine-arbitrary order on ties -> consensus divergence). Append a unique ' +
            'tiebreaker (e.g. action_index) or, if provably deterministic, add it to ' +
            'ALLOWLIST with a rationale:\n' + JSON.stringify(offenders, null, 2));
    });

    // Anti-rot: every allowlist entry must still exist in db.js. A stale entry means
    // the query was changed or removed; the exception must be re-justified or dropped.
    it('has no stale allowlist entries (each still present in db.js)', function () {
        const present = new Set(clauses);
        const stale   = ALLOWLIST.filter(a => !present.has(a.clause)).map(a => a.clause);
        assert.deepStrictEqual(stale, [],
            'ALLOWLIST references ORDER BY clauses no longer in db.js; remove or update them:\n' +
            JSON.stringify(stale, null, 2));
    });

    // Negative control: the detector MUST flag a clause that ranks by a non-unique
    // column with no tiebreaker. Proves the invariant test above is not vacuous.
    it('negative control: flags a tiebreaker-free ORDER BY', function () {
        assert.strictEqual(hasTiebreaker('amount DESC'), false,
            'ORDER BY amount alone must be detected as non-deterministic');
        assert.strictEqual(hasTiebreaker('balance DESC, block_timestamp ASC'), false,
            'ranking by balance then block_timestamp (both non-unique) must be flagged');
        // ...and the detector still accepts a properly-tiebroken clause.
        assert.strictEqual(hasTiebreaker('amount DESC, action_index ASC'), true,
            'a clause with an action_index tiebreaker must pass');
    });

    // The word-boundary matcher must not let a lookup surrogate id (address_id,
    // tick_id, source_id) masquerade as the unique `id` / `source` tiebreaker.
    it('does not accept *_id surrogate columns as the bare id/source tiebreaker', function () {
        assert.strictEqual(hasTiebreaker('address_id ASC'), false,
            'address_id is a per-node AUTO_INCREMENT surrogate, not a canonical tiebreaker');
        assert.strictEqual(hasTiebreaker('source_id DESC'), false,
            'source_id must not satisfy the `source` tiebreaker');
    });
});
