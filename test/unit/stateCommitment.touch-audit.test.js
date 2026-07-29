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
 * The opt-in touched-set audit .
 *
 * Balance leaves have gone missing on every regtest venue, silently: a touched
 * key recorded under a non-canonical name makes getNetBalance return 0,
 * _leafOrNull turns that into null, and the commitment deletes a key that never
 * existed, so the block's balances_root is unchanged and nothing errors. Two
 * defects with that exact signature were found and fixed, but BTC regtest block
 * 10296 skipped under conditions that exclude both, so at least one mechanism is
 * unaccounted for.
 *
 * A silent failure can only be caught in the act, so this asserts the DETECTOR:
 * off by default (a production node pays nothing), loud when the choke point and
 * the block's ledger disagree, and incapable of taking a block down when it
 * itself fails. That last property is the one worth testing hardest: consensus
 * instrumentation that can break consensus is worse than the bug it hunts.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

// SCOPE, stated so the next reader does not over-trust this file: the audit is
// module-private and sits behind computeAndStoreRoots' incremental branch, which
// needs a live schema to drive. These are SOURCE-level assertions on the
// properties that matter operationally (the env gate, both comparison
// directions, the evidence it prints, and that it cannot take a block down).
// They pin the contract; they do not execute it. The behavioural proof is the
// venue run with INDEXER_SMT_TOUCH_AUDIT=1, which is the point of the tool.
describe('touched-set audit @regression', function(){

    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(path.resolve(__dirname, '../../src/stateCommitment.js'), 'utf8');

    it('is OFF unless INDEXER_SMT_TOUCH_AUDIT=1', function(){
        assert.ok(/INDEXER_SMT_TOUCH_AUDIT\s*!==\s*'1'\)\s*return/.test(src),
            'the audit must return immediately when the env flag is unset, so a production ' +
            'node pays nothing for it');
    });

    it('compares in BOTH directions, because either direction is a real fault', function(){
        // missing = the ledger moved and no touch was recorded (the defect).
        // extra   = a touch for a key the ledger did not move (a wrong-key capture,
        //           which is the same bug seen from the other side).
        assert.ok(/const missing\s*=/.test(src) && /const extra\s*=/.test(src),
            'reporting only "missing" would hide the wrong-key capture that causes it');
    });

    it('reports the exact keys, since the raw arguments cannot be recovered later', function(){
        assert.ok(/SMT-TOUCH-AUDIT block=/.test(src), 'the report must name the block');
        assert.ok(/missing\.map\(k => k\.split\('\\t'\)\)/.test(src),
            'the report must carry the (address, tick) pairs, which is the evidence no ' +
            'post-hoc probe can reconstruct once the block is committed');
    });

    it('never takes a block down when the audit itself fails', function(){
        assert.ok(/catch\(e\)\{[\s\S]{0,400}SMT-TOUCH-AUDIT failed/.test(src),
            'the audit must swallow its own errors: consensus instrumentation that can ' +
            'break consensus is worse than the bug it hunts');
    });

    it('is wired into the incremental branch, where the skips happen', function(){
        assert.ok(/_auditTouchedSet\(db, blockIndex, touched\)/.test(src),
            'the audit must run on the branch that applies the touched set; the ' +
            'full-rebuild branch derives from the whole ledger and cannot skip a key');
    });

    it('reads strictly, so a fault surfaces as an audit failure and not a false CLEAN', function(){
        assert.ok(/_auditTouchedSet[\s\S]{0,900}doQueryStrict\(/.test(src),
            'through doQuery a failed read returns [] and every key would look "missing", ' +
            'or worse, an empty expected set would look clean');
    });
});
