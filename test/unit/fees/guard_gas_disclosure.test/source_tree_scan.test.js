// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Utility = require('../../../../src/utility.js');

describe('guard gas dry-run disclosure @regression @tier1', function () {
    it('keeps the ledger tuple unchanged and totals dry-runs only', function () {
        const util = new Utility();
        const debits = [];
        util.resetGuardGasTotals();
        util.billGuardGas(debits, 'GAS', '0.12500000', 'source', {});
        assert.deepStrictEqual(debits, [['GAS', '0.12500000', 'source']]);
        assert.strictEqual(util.guardGasTotal('source'), '0');
        util.billGuardGas(debits, 'GAS', '0.25000000', 'source', { DRY_RUN: true });
        assert.deepStrictEqual(debits[1], ['GAS', '0.25000000', 'source']);
        assert.strictEqual(util.guardGasTotal('source'), '0.25');
    });

    it('routes every action guard-gas debit through the disclosure helper', function () {
        const actionsRoot = path.resolve(__dirname, '../../../../src/actions');
        const pending = [actionsRoot];
        const offenders = [];
        while(pending.length > 0){
            const current = pending.pop();
            for(const entry of fs.readdirSync(current, { withFileTypes: true })){
                const target = path.join(current, entry.name);
                if(entry.isDirectory()) pending.push(target);
                else if(entry.isFile() && entry.name.endsWith('.js') &&
                        /debits\.push\(\[[^\]]*guardFee/.test(fs.readFileSync(target, 'utf8')))
                    offenders.push(path.relative(actionsRoot, target));
            }
        }
        assert.deepStrictEqual(offenders, []);
    });
});
