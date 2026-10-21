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
 * test/unit/db/misc/credit_debit_sum_sql.test.js
 *
 * The per-tick credit/debit sum builder is pure: the table gate, the exact SQL
 * text with and without a filter, and the canonical amount pattern.
 ********************************************************************/

'use strict';

const assert = require('assert');
const { creditDebitSumQuery, CANONICAL_LEDGER_AMOUNT_RE } = require('../../../../src/db/misc/credit_debit_sum_sql');

function expected(table, filter){
    return `SELECT
                    m.tick_id,
                    SUM(CAST(m.amount AS DECIMAL(60,18))) AS amount,
                    SUM(CASE WHEN m.amount REGEXP '^-?[0-9]{1,40}([.][0-9]{1,18})?$' THEN 0 ELSE 1 END) AS non_canonical
                FROM
                    ` + table + ` m
                    INNER JOIN actions       a1 ON (a1.action_index=m.action_index)
                    LEFT  JOIN transactions  t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN tokens        t2 ON (t2.tick_id=m.tick_id)
                    INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                WHERE
                    m.address_id=?` + filter + `
                GROUP BY m.tick_id`;
}

describe('creditDebitSumQuery @tier1', function(){
    it('throws for any table but credits and debits', function(){
        for(const t of ['escrows', 'balances', '', undefined, null, 'credits; DROP TABLE x'])
            assert.throws(() => creditDebitSumQuery(t, ''));
    });

    it('builds the exact SQL for credits and debits without a filter', function(){
        assert.strictEqual(creditDebitSumQuery('credits', ''), expected('credits', ''));
        assert.strictEqual(creditDebitSumQuery('debits', ''), expected('debits', ''));
    });

    it('builds the exact SQL for credits and debits with a filter', function(){
        const f = ' AND m.action_index < ? AND m.tick_id=?';
        assert.strictEqual(creditDebitSumQuery('credits', f), expected('credits', f));
        assert.strictEqual(creditDebitSumQuery('debits', f), expected('debits', f));
    });

    it('accepts canonical amounts in the shared pattern', function(){
        const accepted = ['1', '-0.5', '0.' + '1'.repeat(18), '1'.repeat(40)];
        for(const a of accepted) assert.ok(CANONICAL_LEDGER_AMOUNT_RE.test(a), a);
    });

    it('refuses non-canonical amounts in the shared pattern', function(){
        const refused = ['1e3', '1.', '0.' + '1'.repeat(19), '1'.repeat(41), '', '.5', '+1'];
        for(const a of refused) assert.ok(!CANONICAL_LEDGER_AMOUNT_RE.test(a), a);
    });
});
