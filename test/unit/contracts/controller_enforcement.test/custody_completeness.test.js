'use strict';

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
 ********************************************************************/

const assert = require('assert');
const { util, BASE } = require('./helpers/controller_fixture');

function mkDb(lookups){
    return {
        config: { ASSERT_CONTROLLER_COMPLETENESS: true, CHAIN: 'BTC', GAS: 'XCHAIN' },
        getTickerId: async (tick) => { lookups.push(tick); return 1; },
        getEffectiveTokenControllerForGuard: async () => ({ contract_index: 9, is_unbind: 0 }),
        createDebit: async () => {},
        createCredit: async () => {},
        createEscrow: async () => {}
    };
}

function actionData(action, extra){
    return Object.assign({}, BASE, { ACTION: action, CONTRACT_ACTION_INDEX: 77 }, extra || {});
}

async function writeLedger(db, data, debits){
    await util.processTransactionLedgerChanges(db, data, [], debits, []);
}

describe('controller completeness custody routing', function () {
    const custody = 'C:BTC:77';
    const custodyDebits = [['AAA', '1', BASE.SOURCE], ['AAA', '2', custody]];

    for(const action of ['DEPOSIT', 'WITHDRAW']){
        it(action + ' skips SOURCE and custody debits before the custody guard is armed', async function () {
            const lookups = [];
            await assert.doesNotReject(writeLedger(mkDb(lookups), actionData(action), custodyDebits));
            assert.deepStrictEqual(lookups, []);
        });

        it(action + ' accepts armed SOURCE and custody debits when the tick was guarded', async function () {
            const data = actionData(action, { _CUSTODY_GUARD_ARMED: true, _GUARDED_TICKS: { AAA: true } });
            await assert.doesNotReject(writeLedger(mkDb([]), data, custodyDebits));
        });
    }

    it('DEPOSIT rejects an armed unguarded controlled SOURCE debit', async function () {
        const data = actionData('DEPOSIT', { _CUSTODY_GUARD_ARMED: true });
        await assert.rejects(
            writeLedger(mkDb([]), data, [['AAA', '1', BASE.SOURCE]]),
            /controller completeness: unguarded transfer-controlled debit of AAA from SOURCE \(action 5\)/
        );
    });

    it('WITHDRAW rejects an armed unguarded controlled custody debit', async function () {
        const data = actionData('WITHDRAW', { _CUSTODY_GUARD_ARMED: true });
        await assert.rejects(
            writeLedger(mkDb([]), data, [['AAA', '1', custody]]),
            /controller completeness: unguarded transfer-controlled debit of AAA from C:BTC:77 \(action 5\)/
        );
    });

    it('SEND still rejects an unguarded controlled SOURCE debit', async function () {
        await assert.rejects(
            writeLedger(mkDb([]), actionData('SEND'), [['AAA', '1', BASE.SOURCE]]),
            /controller completeness: unguarded transfer-controlled debit of AAA from SOURCE \(action 5\)/
        );
    });

    it('SEND still ignores an unguarded controlled debit at another address', async function () {
        const lookups = [];
        await assert.doesNotReject(
            writeLedger(mkDb(lookups), actionData('SEND'), [['AAA', '1', 'elsewhere']])
        );
        assert.deepStrictEqual(lookups, []);
    });
});
