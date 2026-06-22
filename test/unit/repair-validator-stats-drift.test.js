/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/repair-validator-stats-drift.test.js
 *
 * Drift guard: scripts/repair-validator-stats.js must stay structurally
 * in sync with the rollback recompute in src/rollback.js
 * (_recomputeAttestationValidatorStats). Both walk the same source tables
 * with the same eligibility predicate; only the cutoff value differs
 * (the repair script uses the chain tip, the rollback uses block_index-1,
 * which is equivalent when the repair target is tip+1). If the predicates
 * diverge silently, a re-run of the repair script after a reorg could
 * produce a table that disagrees with what a clean replay produces, which
 * would cause ledger-hash divergence once Phase 4 slashing consumes these
 * counters.
 *
 * Strategy: extract normalised predicate tokens (column comparisons,
 * existence sub-selects) from both source files and assert they match.
 * Whitespace and parameter-value differences are normalised away; only
 * structural / semantic differences cause a failure.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPAIR_FILE   = path.join(__dirname, '..', '..', 'scripts', 'repair-validator-stats.js');
const ROLLBACK_FILE = path.join(__dirname, '..', '..', 'src', 'rollback.js');

// Extract the SQL string for the expired-requests query from a source file.
// Both files assign the result to a variable named expiredReqs via doQuery / db.doQuery.
// We look for the backtick template literal that contains the SELECT and return
// the content up to the closing backtick. We collapse whitespace to make the
// comparison insensitive to formatting drift.
function extractExpiredReqsSql(src){
    // Locate the SELECT block associated with the expiredReqs assignment.
    // Both files use a backtick template literal passed as the first arg to doQuery.
    const marker = 'expiredReqs';
    const idx = src.indexOf(marker);
    if(idx === -1) throw new Error('Could not find "expiredReqs" in source');
    // Advance past the marker to find the first backtick (start of SQL template literal).
    const tick1 = src.indexOf('`', idx);
    if(tick1 === -1) throw new Error('Could not find opening backtick after expiredReqs');
    const tick2 = src.indexOf('`', tick1 + 1);
    if(tick2 === -1) throw new Error('Could not find closing backtick for expiredReqs SQL');
    return src.slice(tick1 + 1, tick2);
}

// Normalise a SQL string: lowercase, collapse all whitespace runs to a single
// space, strip leading/trailing whitespace. This makes the comparison insensitive
// to indentation and line-break differences between the two files.
function normaliseSql(sql){
    return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Extract predicate tokens from a normalised SQL string. We capture:
//   - Each comparison/expression on an identifiable column (deadline_block, request_status,
//     response_status, version).
//   - Whether a NOT EXISTS sub-select is present.
//   - Column names referenced in the NOT EXISTS sub-select.
// This is intentionally structural rather than value-level: the cutoff parameter
// placeholder (?) is preserved, so value-only differences (tip vs block_index-1)
// do not affect the comparison.
function extractPredicateTokens(normSql){
    let tokens = [];

    // Each predicate clause we care about, normalised.
    const predicates = [
        'ar.version = 0',
        'ar.deadline_block < ?',
        "ar.request_status <> 'rejected'",
        'not exists',
        'r.version = 1',
        'r.request_id = ar.request_id',
        'r.status_id = ?',
        "r.response_status in ('ok', 'expired')"
    ];

    for(const p of predicates){
        tokens.push({ predicate: p, present: normSql.includes(p) });
    }

    return tokens;
}

describe('repair-validator-stats drift guard @regression', function(){

    let repairSrc, rollbackSrc;

    before(function(){
        repairSrc   = fs.readFileSync(REPAIR_FILE,   'utf8');
        rollbackSrc = fs.readFileSync(ROLLBACK_FILE, 'utf8');
    });

    it('both files define an expiredReqs SQL query (sanity check)', function(){
        assert.ok(repairSrc.includes('expiredReqs'),
            REPAIR_FILE + ' must define an expiredReqs query');
        assert.ok(rollbackSrc.includes('expiredReqs'),
            ROLLBACK_FILE + ' must define an expiredReqs query');
    });

    it('expired-request predicate structure matches between repair script and rollback recompute', function(){
        const repairSql   = normaliseSql(extractExpiredReqsSql(repairSrc));
        const rollbackSql = normaliseSql(extractExpiredReqsSql(rollbackSrc));

        const repairTokens   = extractPredicateTokens(repairSql);
        const rollbackTokens = extractPredicateTokens(rollbackSql);

        // Every predicate present in the rollback must also be present in the repair
        // script (and vice versa). A missing token means one has grown a new filter
        // condition that the other has not adopted, which silently diverges the recompute.
        for(const { predicate, present } of rollbackTokens){
            const repairHas = repairTokens.find(t => t.predicate === predicate);
            assert.strictEqual(
                repairHas && repairHas.present,
                present,
                'repair-validator-stats.js predicate "' + predicate + '" disagrees with rollback.js ' +
                '_recomputeAttestationValidatorStats. They must stay structurally in sync. ' +
                'If a predicate was added/removed in one, apply the same change to the other.'
            );
        }

        for(const { predicate, present } of repairTokens){
            const rollbackHas = rollbackTokens.find(t => t.predicate === predicate);
            assert.strictEqual(
                rollbackHas && rollbackHas.present,
                present,
                'rollback.js predicate "' + predicate + '" disagrees with repair-validator-stats.js. ' +
                'They must stay structurally in sync.'
            );
        }
    });

    it('fulfilled-count query structure is consistent across both files', function(){
        // The fulfilled_count aggregation (ok responses with validator_signatures)
        // uses the same filter in both files. Check the key columns appear in the
        // fulfilled-count SELECT block in both.
        const repairNorm   = normaliseSql(repairSrc);
        const rollbackNorm = normaliseSql(rollbackSrc);

        const required = [
            "version = 1",
            "response_status = 'ok'",
            "validator_signatures is not null"
        ];
        for(const clause of required){
            assert.ok(repairNorm.includes(clause),
                'repair-validator-stats.js is missing fulfilled-count clause: ' + clause);
            assert.ok(rollbackNorm.includes(clause),
                'rollback.js is missing fulfilled-count clause: ' + clause);
        }
    });
});
