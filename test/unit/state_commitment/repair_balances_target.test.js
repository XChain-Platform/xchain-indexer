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
 ********************************************************************/

'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const Target = require('../../../src/state_commitment/repair_balances_target.js');

describe('repair balances root target guard', function(){
    it('accepts an omitted or matching expected tip', function(){
        assert.strictEqual(Target.requestedTipError(null, 20), null);
        assert.strictEqual(Target.requestedTipError(20, 20), null);
    });

    it('refuses historical and future expected tips', function(){
        assert.match(Target.requestedTipError(19, 20), /current tip 20.*below/);
        assert.match(Target.requestedTipError(21, 20), /current tip 20.*above/);
    });

    it('refuses apply before database access unless the indexer is stopped', function(){
        const script = path.resolve(__dirname, '../../../bin/repair-balances-root.js');
        const run = childProcess.spawnSync(process.execPath,
            [script, '--chain', 'BTC', '--network', 'regtest', '--apply'],
            { encoding: 'utf8' });
        assert.strictEqual(run.status, 3);
        assert.match(run.stderr, /stop the indexer process.*--indexer-stopped/);
    });

    it('requires both tip height and pre-repair balances root to stay fixed', function(){
        const before = { block_index: 20, balances_root: 'old' };
        assert.strictEqual(Target.tipUnchanged(before, { block_index: 20, balances_root: 'old' }), true);
        assert.strictEqual(Target.tipUnchanged(before, { block_index: 21, balances_root: 'old' }), false);
        assert.strictEqual(Target.tipUnchanged(before, { block_index: 20, balances_root: 'new' }), false);
        assert.strictEqual(Target.tipUnchanged(before, null), false);
        const script = fs.readFileSync(path.resolve(__dirname, '../../../bin/repair-balances-root.js'), 'utf8');
        const targetCheck = script.indexOf('Target.requestedTipError(');
        const rebuild = script.indexOf('SC.buildFullBalancesRoot(');
        const begin = script.indexOf('await db.beginTransaction()');
        const lockedTip = script.indexOf('await tipRow(true)', begin);
        const update = script.indexOf('UPDATE state_tree_roots SET balances_root=?, state_root=?', lockedTip);
        const conditional = script.indexOf('AND block_index=? AND balances_root=?', update);
        assert.ok(targetCheck > 0 && targetCheck < rebuild,
            'the expected-tip refusal must run before the full-ledger rebuild');
        assert.ok(begin > rebuild && lockedTip > begin && update > lockedTip && conditional > update,
            'the real tip must be locked before a balances-root-conditional update inside the transaction');
    });
});
