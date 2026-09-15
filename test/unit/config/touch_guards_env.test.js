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
 * The balances_root guards read INDEXER_TOUCH_GUARD and
 * INDEXER_SMT_TOUCH_AUDIT through src/config.js's call-time readEnvNow, never
 * process.env directly and never a load-time snapshot.
 *
 * Why call time matters: an operator sets INDEXER_TOUCH_GUARD=warn on a node
 * that is already running a block loop, and the suites flip it per case. A
 * value captured when the module loaded would keep refusing (or keep
 * committing) after the flip. So these cases DRIVE the guard across a flip in
 * one process, which a snapshot cannot pass, rather than reading its source.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { enforceTouchedSet } = require('../../../src/state_commitment/touch_guards.js');

const GUARDS_PATH = path.resolve(__dirname, '../../../src/state_commitment/touch_guards.js');

// A block whose ledger moved one key the commitment never applied: the fault
// the guard exists to refuse.
function dbMovingOneKey(){
    return { doQueryStrict: async () => [{ address: 'addr1', tick: 'TICK' }] };
}

// Run fn with name set to value (undefined deletes it), then put the real value back.
async function withEnv(name, value, fn){
    const real = process.env[name];
    if(value === undefined) delete process.env[name]; else process.env[name] = value;
    try { return await fn(); }
    finally { if(real === undefined) delete process.env[name]; else process.env[name] = real; }
}

describe('touch guards env routing @regression', function(){
    it('has no process.env read of its own; the config home does the read', function(){
        const src = fs.readFileSync(GUARDS_PATH, 'utf8');
        assert.ok(!/process\.env/.test(src),
            'every environment read in the guards goes through src/config.js readEnvNow');
        assert.ok(/require\('\.\.\/config\.js'\)/.test(src), 'the guards import the config home');
    });

    it('re-reads INDEXER_TOUCH_GUARD on every call, so a flip on a running node takes effect', async function(){
        const realErr = console.error;
        console.error = () => {};
        try {
            await withEnv('INDEXER_TOUCH_GUARD', undefined, () => assert.rejects(
                enforceTouchedSet(dbMovingOneKey(), 7, []), /touched-set guard FAILED at block 7/));
            await withEnv('INDEXER_TOUCH_GUARD', 'warn', async () => {
                await enforceTouchedSet(dbMovingOneKey(), 7, []);
            });
            await withEnv('INDEXER_TOUCH_GUARD', undefined, () => assert.rejects(
                enforceTouchedSet(dbMovingOneKey(), 7, []), /touched-set guard FAILED at block 7/,
                'unsetting the valve restores the refusal without a restart'));
        } finally {
            console.error = realErr;
        }
    });

    it('reports extra keys only while INDEXER_SMT_TOUCH_AUDIT=1 is set at call time', async function(){
        const logged = [];
        const realLog = console.log, realInfo = console.info;
        console.log = console.info = (...a) => logged.push(a.join(' '));
        try {
            // Applied carries one key the ledger did not move: legitimate extra.
            const touched = ['addr1\tTICK', 'escrow\tTICK'];
            await withEnv('INDEXER_SMT_TOUCH_AUDIT', undefined,
                () => enforceTouchedSet(dbMovingOneKey(), 8, touched));
            const quiet = logged.filter((l) => /SMT-TOUCH-AUDIT/.test(l)).length;
            await withEnv('INDEXER_SMT_TOUCH_AUDIT', '1',
                () => enforceTouchedSet(dbMovingOneKey(), 8, touched));
            const audited = logged.filter((l) => /SMT-TOUCH-AUDIT block=8/.test(l)).length;
            assert.strictEqual(quiet, 0, 'no audit line while the flag is unset');
            assert.strictEqual(audited, 1, 'one audit line once the flag is set, without a reload');
        } finally {
            console.log = realLog;
            console.info = realInfo;
        }
    });
});
