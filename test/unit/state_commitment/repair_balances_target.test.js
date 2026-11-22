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
const { assembleStateRoot } = require('../../../src/state_commitment/state_root.js');

const BALANCES_ROOT = '11'.repeat(32);
const STAKES_ROOT = '22'.repeat(32);
const CONTRACT_ROOT = '33'.repeat(32);
// The repair tool's pre-check reassembles the STORED row, never the rebuilt root.
const STORED_ASSEMBLY = 'SC.assembleStateRoot(String(before.balances_root), String(before.stakes_root), extras)';

function committedRow(extras){
    return {
        block_index: 20,
        balances_root: BALANCES_ROOT,
        stakes_root: STAKES_ROOT,
        state_root: assembleStateRoot(BALANCES_ROOT, STAKES_ROOT, extras),
        contract_state_root: extras && extras.contract_state_root,
    };
}

// What the repair tool hands the guard: the row reassembled from its own stored parts.
function rowError(row){
    return Target.committedRowError(row,
        assembleStateRoot(String(row.balances_root), String(row.stakes_root), Target.storedExtras(row)));
}

describe('repair balances root target guard', function(){
    it('accepts an omitted or matching expected tip', function(){
        assert.strictEqual(Target.requestedTipError(null, 20), null);
        assert.strictEqual(Target.requestedTipError(20, 20), null);
        const base = committedRow(null);
        const extended = committedRow({ contract_state_root: CONTRACT_ROOT });
        assert.strictEqual(rowError(base), null);
        assert.strictEqual(rowError(extended), null);
        assert.strictEqual(Target.storedExtras(base), null);
        assert.deepStrictEqual(Target.storedExtras(extended), { contract_state_root: CONTRACT_ROOT });
    });

    it('refuses historical and future expected tips', function(){
        assert.match(Target.requestedTipError(19, 20), /current tip 20.*below/);
        assert.match(Target.requestedTipError(21, 20), /current tip 20.*above/);
        const dropped = committedRow({ contract_state_root: CONTRACT_ROOT });
        dropped.contract_state_root = null;
        assert.match(rowError(dropped), /does not reassemble/);
        const tampered = committedRow(null);
        tampered.state_root = '44'.repeat(32);
        assert.match(rowError(tampered), /does not reassemble/);
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
        const before = committedRow({ contract_state_root: CONTRACT_ROOT });
        assert.strictEqual(Target.tipUnchanged(before, { ...before }), true);
        assert.strictEqual(Target.tipUnchanged(before, { ...before, block_index: 21 }), false);
        assert.strictEqual(Target.tipUnchanged(before, { ...before, balances_root: 'new' }), false);
        assert.strictEqual(Target.tipUnchanged(before, { ...before, stakes_root: 'new' }), false);
        assert.strictEqual(Target.tipUnchanged(before, { ...before, state_root: 'new' }), false);
        assert.strictEqual(Target.tipUnchanged(before, { ...before, contract_state_root: null }), false);
        assert.strictEqual(Target.tipUnchanged(before, null), false);
        const script = fs.readFileSync(path.resolve(__dirname, '../../../bin/repair-balances-root.js'), 'utf8');
        const targetCheck = script.indexOf('Target.requestedTipError(');
        const committedCheck = script.indexOf('Target.committedRowError(');
        const rebuild = script.indexOf('SC.buildFullBalancesRoot(');
        const storedAssembly = script.indexOf(STORED_ASSEMBLY);
        const begin = script.indexOf('await db.beginTransaction()');
        const lockedTip = script.indexOf('await tipRow(true)', begin);
        const update = script.indexOf('UPDATE state_tree_roots SET balances_root=?, state_root=?', lockedTip);
        const conditional = script.indexOf('AND block_index=? AND balances_root=?', update);
        const stateConditional = script.indexOf('AND balances_root=? AND state_root=?', update);
        assert.ok(targetCheck > 0 && committedCheck > targetCheck && committedCheck < rebuild,
            'the expected-tip and committed-row refusals must run before the full-ledger rebuild');
        assert.ok(storedAssembly > committedCheck && storedAssembly < rebuild, 'the refusal must reassemble the stored row');
        assert.ok(begin > rebuild && lockedTip > begin && update > lockedTip && conditional > update,
            'the real tip must be locked before a balances-root-conditional update inside the transaction');
        assert.ok(stateConditional > update, 'the conditional update must bind the checked state_root');
        assert.strictEqual(script.includes('const check = SC.assembleStateRoot(rebuilt'), false);
    });
});
