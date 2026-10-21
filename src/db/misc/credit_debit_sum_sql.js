/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Pure SQL builder for the per-tick credit/debit sum of one address.
 *
 * It shares the FROM, joins and `m.address_id=?` head with getAddressCreditDebit
 * (db/misc/index.js), then appends the caller's filter and groups by tick. Each
 * group carries the exact 18 dp sum plus the count of rows whose stored amount
 * is not a canonical ledger decimal, so a comparator can tell a sum that is
 * trustworthy from one taken over malformed text.
 ********************************************************************/

'use strict';

const ledgerPrecision = require('../../consensus/ledger_amount_precision_gate');

// Canonical stored amount: optional sign, 1-40 integer digits, optional fraction
// of 1-18 digits. The SQL REGEXP and the JS comparator share this one literal.
const CANONICAL_LEDGER_AMOUNT_RE = /^-?[0-9]{1,40}([.][0-9]{1,18})?$/;

function creditDebitSumQuery(table, filterSql){
    if(table !== 'credits' && table !== 'debits')
        throw new Error('creditDebitSumQuery: table must be credits or debits');
    return `SELECT
                    m.tick_id,
                    ` + ledgerPrecision.exactSumSql('m.amount') + ` AS amount,
                    SUM(CASE WHEN m.amount REGEXP '` + CANONICAL_LEDGER_AMOUNT_RE.source + `' THEN 0 ELSE 1 END) AS non_canonical
                FROM
                    ` + table + ` m
                    INNER JOIN actions       a1 ON (a1.action_index=m.action_index)
                    LEFT  JOIN transactions  t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN tokens        t2 ON (t2.tick_id=m.tick_id)
                    INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                WHERE
                    m.address_id=?` + (filterSql || '') + `
                GROUP BY m.tick_id`;
}

// Shape the grouped rows of creditDebitSumQuery into the sparse array the JS fold
// returns: only the ticks present are own keys, each holding the 18 dp sum. Any
// row with a non-canonical stored amount, or a non_canonical count that is not a
// plain zero, returns null so the caller keeps the JS fold. No rows is an empty
// array, not null.
function ledgerArrayFromSumRows(rows, util){
    const data = [];
    for(const row of rows){
        if(row.non_canonical === null || row.non_canonical === undefined || Number(row.non_canonical) !== 0)
            return null;
        data[row.tick_id] = util.bcadd(0, row.amount, ledgerPrecision.LEDGER_AMOUNT_PRECISION);
    }
    return data;
}

module.exports = {
    CANONICAL_LEDGER_AMOUNT_RE,
    creditDebitSumQuery,
    ledgerArrayFromSumRows
};
