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
 * The touched-set guard : a block whose ledger moved keys the
 * commitment did not apply must be REFUSED, not committed.
 *
 * Balance leaves have gone missing on every regtest venue (BTC 15 of 1531
 * ledger-changing blocks, LTC 8 of 880, DOGE 2 of 648). Two defects were found
 * and fixed, both mis-diagnosed at least once first, and block 10296 then
 * skipped under conditions that exclude both, so at least one mechanism is still
 * unknown. What every mechanism shares is not a cause but SILENCE: the update
 * becomes a no-op, the root does not move, nothing errors, and every peer
 * running the same code agrees. This guard closes the class instead of chasing
 * causes, which is what protects against the mechanisms not yet found.
 *
 * The subset direction is the load-bearing design decision and is tested
 * hardest. `extra` (applied minus expected) has LEGITIMATE causes and must never
 * halt a chain: escrows are recorded as touches but are not in the expected set,
 * and backdated cooldown-refund credits are captured in the block that writes
 * them while a block-range query attributes them to the block that owns the
 * action. Enforcing equality would halt healthy chains.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/stateCommitment.js'), 'utf8');

// The guard is module-private and sits inside computeAndStoreRoots' incremental
// branch, which needs a live schema to drive end to end. Behaviour is therefore
// exercised by re-implementing NOTHING: the assertions below read the real
// source for the properties that decide whether a chain halts, which is what a
// reviewer would otherwise have to eyeball. Stated plainly so nobody mistakes
// this for execution coverage.
describe('touched-set guard @regression', function(){

    it('is ON by default: no env flag gates the check itself', function(){
        // The whole point is that it protects nodes nobody remembered to
        // configure. A gate here would put it back to opt-in.
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(!/INDEXER_SMT_TOUCH_AUDIT[^\n]*\)\s*return;/.test(body),
            'the guard must not return early on an audit flag');
        assert.ok(!/^\s*if\s*\(process\.env\.INDEXER_TOUCH_GUARD[^\n]*\)\s*return;/m.test(body),
            'the guard must not be switched off wholesale by an env var');
    });

    it('ENFORCES only the missing direction, never extra', function(){
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        // The throw must be reached from `missing`, and `extra` must not throw:
        // escrows and backdated cooldown credits legitimately land in extra, so
        // enforcing equality would halt healthy chains.
        assert.ok(/if\(!missing\.length\) return;/.test(body),
            'a clean subset must return before the throw');
        const extraIdx = body.indexOf('const extra');
        const throwIdx = body.indexOf('throw new Error(msg)');
        assert.ok(extraIdx > -1 && throwIdx > extraIdx,
            'extra is computed for reporting only, ahead of the missing-driven throw');
        const extraBlock = body.slice(extraIdx, body.indexOf('if(!missing.length)'));
        assert.ok(!/throw/.test(extraBlock), 'extra must never throw');
    });

    it('reports extra only under the audit flag, because it is noisy by design', function(){
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(/INDEXER_SMT_TOUCH_AUDIT === '1'[\s\S]{0,400}extra/.test(body),
            'extra reporting is gated so healthy chains do not log escrow keys every block');
    });

    it('reads STRICTLY, so a failed check can never pass as clean', function(){
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(/doQueryStrict\(/.test(body) && !/[^t]\bdb\.doQuery\(/.test(body),
            'through doQuery a failed read returns [], which the guard would read as ' +
            '"the ledger moved nothing" and pass every block: worse than no guard at all');
    });

    it('does NOT swallow its own errors (that was the diagnostic contract, not the guard one)', function(){
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(!/catch\s*\(/.test(body),
            'a swallowed failure is a silent pass, which is exactly the property being fixed');
    });

    it('has an operational downgrade that is documented as divergence, not a knob', function(){
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(/INDEXER_TOUCH_GUARD === 'warn'/.test(body), 'a safety valve must exist');
        assert.ok(/diverge/.test(body),
            'the warn path must say plainly that the node commits a root it knows is incomplete');
    });

    it('runs on the incremental branch only', function(){
        // The full-rebuild branch derives from the entire ledger and cannot skip
        // a key, so guarding it would cost a query for no possible finding.
        assert.ok(/await _enforceTouchedSet\(db, blockIndex, touched\);/.test(SRC));
        const guardCall = SRC.indexOf('await _enforceTouchedSet(db, blockIndex, touched)');
        const fullBuild = SRC.indexOf('balancesRoot = await buildFullBalancesRoot(db, chain, network, blockIndex);');
        assert.ok(guardCall > fullBuild,
            'the guard belongs after the incremental branch, not on the full-rebuild path');
    });

    it('returns early when the block moved no ledger keys (the common case is free)', function(){
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(/if\(!expected\.size\) return;/.test(body),
            'a block with no ledger rows must cost nothing beyond the one query');
    });

    it('names the block and the exact keys in the failure', function(){
        const body = SRC.slice(SRC.indexOf('async function _enforceTouchedSet'),
                               SRC.indexOf('// ---- Orchestrator ---'));
        assert.ok(/block ' \+ blockIndex/.test(body), 'the operator needs the height');
        assert.ok(/keys=' \+ detail/.test(body),
            'and the keys, which are unrecoverable once the block is past');
        assert.ok(//.test(body), 'and a pointer to the investigation');
    });
});
