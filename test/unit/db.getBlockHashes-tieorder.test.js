/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db.getBlockHashes-tieorder.test.js
 *
 * CONSENSUS REGRESSION GUARD for db.getBlockHashes() tie-order determinism (fix ffd061a).
 *
 * The five tables below feed the consensus ledger/contract hash and have NO primary key
 * (credits/debits/escrows) or a legitimate multi-row-per-action shape (deposits/withdrawals).
 * An ISSUE, for example, writes two credits with the SAME action_index (protocol-fee credit +
 * mint credit). If getBlockHashes orders only by action_index, the order of those tied rows is
 * engine-unspecified: two honest validators whose MySQL returns the tie differently compute
 * different ledger hashes → chain fork, and (worse) divergent ANCHOR checkpoint signatures.
 * This was observed live: BTC↔DOGE forked at block 306 with byte-identical rows in different
 * order. Fix ffd061a added full-row secondary sort keys so every SELECTed column participates
 * in the ORDER BY, giving a total order on the hashed projection.
 *   See claude/reports/2026-06-12_p3b-phase3-three-chain-parity-tip.md §2.
 *
 * Technique mirrors db.queries.test.js: stub doQuery on a prototype-borrowed Database so the
 * real getBlockHashes logic runs against injected rows — no live MariaDB required. Because the
 * stub bypasses the engine's ORDER BY, the determinism property test re-derives the sort order
 * FROM THE ACTUAL QUERY STRING (orderByCols) and applies it in JS; if a future edit drops a
 * disambiguating column, the modeled sort drops it too and the property fails. A negative
 * control (sort by action_index alone = the pre-fix query) proves the test has teeth.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// ---------------------------------------------------------------------------
// The tie-prone getBlockHashes queries and the FULL set of columns each one
// SELECTs (== the set that MUST appear in its ORDER BY for a total row order).
// ---------------------------------------------------------------------------
const TIE_PRONE = {
    credits:     ['action_index', 'address_id', 'tick_id', 'amount'],
    debits:      ['action_index', 'address_id', 'tick_id', 'amount'],
    escrows:     ['action_index', 'address_id', 'tick_id', 'amount'],
    deposits:    ['action_index', 'contract_index', 'source_id', 'tick_id', 'amount', 'status_id'],
    withdrawals: ['action_index', 'contract_index', 'source_id', 'tick_id', 'amount', 'status_id']
};

// Which tie-prone table (if any) a query reads from.
function tableOf(sql) {
    const m = sql.match(/FROM\s+(credits|debits|escrows|deposits|withdrawals)\b/i);
    return m ? m[1].toLowerCase() : null;
}

// Bare column names from a query's trailing ORDER BY (strips alias. prefix and ASC/DESC).
function orderByCols(sql) {
    const up  = sql.toUpperCase();
    const idx = up.lastIndexOf('ORDER BY');
    if (idx < 0) return [];
    const clause = sql.slice(idx + 'ORDER BY'.length).split(/;|\bLIMIT\b/i)[0];
    return clause
        .split(',')
        .map(t => t.trim()
            .replace(/\s+(ASC|DESC)\s*$/i, '')
            .replace(/^[A-Za-z0-9_]+\./, '')
            .trim())
        .filter(Boolean);
}

// Deterministic numeric-aware sort that is STABLE on a full tie (returns 0), so a query
// ordering by too-few columns leaves the injected scramble order intact — the whole point.
function sortByCols(rows, cols) {
    return rows.slice().sort((a, b) => {
        for (const c of cols) {
            const av = a[c], bv = b[c];
            let cmp;
            if (av == null && bv == null)       cmp = 0;
            else if (av == null)                cmp = -1;
            else if (bv == null)                cmp = 1;
            else if (!isNaN(Number(av)) && !isNaN(Number(bv))) cmp = Number(av) - Number(bv);
            else cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
            if (cmp !== 0) return cmp;
        }
        return 0;
    });
}

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    // Replace the real pool so the constructor doesn't try to connect.
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

// Run getBlockHashes returning the given credit rows (sorted by `forceCols`, or by the
// query's own ORDER BY when omitted); every other query returns []. Yields the ledger hash.
async function ledgerHash(creditRows, forceCols) {
    const db = makeDb();
    sinon.stub(db, 'doQuery').callsFake(async (sql) => {
        if (tableOf(sql) === 'credits') {
            return sortByCols(creditRows, forceCols || orderByCols(sql));
        }
        return [];
    });
    const info = await db.getBlockHashes(306);
    return info.ledger.hash;
}

afterEach(function () { sinon.restore(); });

// ---------------------------------------------------------------------------
describe('Database.getBlockHashes() consensus tie-order determinism (ffd061a) @regression @tier1', function () {

    // (1) Structural guard: every SELECTed column of each tie-prone query must participate
    //     in its ORDER BY. Survives future query edits — drop a column and this fails.
    it('orders every tie-prone ledger/contract query by all of its projected columns', async function () {
        const db   = makeDb();
        const seen = {};
        sinon.stub(db, 'doQuery').callsFake(async (sql) => {
            const t = tableOf(sql);
            if (t) seen[t] = orderByCols(sql);
            return [];
        });
        await db.getBlockHashes(306);

        for (const [table, cols] of Object.entries(TIE_PRONE)) {
            assert.ok(seen[table], `getBlockHashes never issued a query against '${table}'`);
            for (const col of cols) {
                assert.ok(
                    seen[table].includes(col),
                    `getBlockHashes '${table}' ORDER BY must include '${col}' for tie-order ` +
                    `determinism (ffd061a) — got [${seen[table].join(', ')}]`
                );
            }
        }
    });

    // (2) Property: two credits sharing an action_index hash identically no matter what
    //     physical order the engine returns them in (the ISSUE fee-credit + mint-credit case).
    it('produces an identical ledger hash regardless of tied-row return order', async function () {
        // Same logical rows, same action_index, differing only in the disambiguating columns.
        const feeCredit  = { action_index: 5, address_id: 10, tick_id: 1, amount: '100' };
        const mintCredit = { action_index: 5, address_id: 20, tick_id: 1, amount: '900' };

        const hashAB = await ledgerHash([feeCredit, mintCredit]);
        const hashBA = await ledgerHash([mintCredit, feeCredit]);

        assert.strictEqual(
            hashAB, hashBA,
            'ledger hash must not depend on the engine-returned order of two rows that share an action_index'
        );
    });

    // (3) Negative control: with the PRE-FIX ordering (action_index only), the same two
    //     scrambles DO fork — proving the property test actually detects the regression.
    it('negative control: action_index-only ordering forks on the tied rows', async function () {
        const feeCredit  = { action_index: 5, address_id: 10, tick_id: 1, amount: '100' };
        const mintCredit = { action_index: 5, address_id: 20, tick_id: 1, amount: '900' };

        const hashAB = await ledgerHash([feeCredit, mintCredit], ['action_index']);
        const hashBA = await ledgerHash([mintCredit, feeCredit], ['action_index']);

        assert.notStrictEqual(
            hashAB, hashBA,
            'sanity: action_index-only ordering MUST fork here, else the property test above is vacuous'
        );
    });
});
