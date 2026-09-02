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
 **********************************************************************
 * test/unit/price-barrier-dry-run-scope.test.js
 *
 * The price-barrier backstop must fire for BLOCK PROCESSING only,
 * never for a fee-quote dry run.
 *
 * WHY THIS EXISTS: `_assertPriceBarrierNotSkipped` is a consensus backstop. It
 * used to decide "am I inside the block loop?" by asking whether a txEpochStore
 * context existed at all, under a comment asserting that only the block loop
 * installs one. That was false. `Actions._dryRunAction` installs a context too,
 * and for a good reason of its own - it holds the shared transaction and wants
 * the same M-16 zombie-write fence a block gets - so every public /feequote
 * whose dry run read the price mirror during a barrier-skipped block answered
 * `handler threw: ... PRICE_BARRIER_DEFERRED`. Measured live on RDOGE regtest
 * 2026-09-01, where it killed three consecutive SWEEP drives while the identical
 * quote replayed `valid` a minute later.
 *
 * The second consequence is the one that outranks the wallet campaign that found
 * it, and case 2 below is the test that pins it: the guard's FIRST act is
 * `ix.priceBarrierForceBlock = ix.priceBarrierBlock`, so before the fix an
 * unauthenticated public read wrote block-loop state on a launched testnet.
 *
 * The fix splits the two context kinds (`runInTxEpoch` = consensus,
 * `runInDryRunEpoch` = fenced but not consensus) and keys the barrier on the
 * flag. Cases 5 and 6 are the other half of the claim: the split must not have
 * weakened M-16, which still fences a stale epoch in BOTH kinds of context.
 *
 * These exercise the real methods against the real module-level AsyncLocalStorage
 * via the prototype, with a plain object as `this`. No pool is constructed and
 * nothing connects: the behaviour under test is entirely context propagation.
 */

const assert   = require('assert');
const Database = require('../../src/db.js');

// A Database-shaped `this` with no connection: only the fields these two guards
// actually read. `throwError` mirrors util's contract of rethrowing an Error
// object unchanged, which is what preserves `err.code` for rethrowIfInfraFault.
function stubDb({ barrierSkipped = true, epoch = 7 } = {}) {
    const db = Object.create(Database.prototype);
    db.util = {
        throwError(e) { throw (typeof e === 'string' ? new Error(e) : e); },
    };
    db.indexer = {
        priceBarrierSkipped:   barrierSkipped,
        priceBarrierBlock:     1251,
        priceBarrierForceBlock: null,
    };
    db._txEpoch = epoch;
    return db;
}

function capture(fn) {
    try { fn(); return null; } catch (e) { return e; }
}

describe('the price barrier is scoped to consensus, not to "a context exists"', () => {

    it('1. fires inside a BLOCK-LOOP context when the block skipped the barrier', () => {
        const db  = stubDb();
        const err = capture(() =>
            db.runInTxEpoch(7, () => db._assertPriceBarrierNotSkipped('getLatestPrice')));

        assert.ok(err, 'the backstop must still defer a real block that read an uncovered mirror');
        assert.strictEqual(err.code, 'PRICE_BARRIER_DEFERRED',
            'the typed code is what makes rethrowIfInfraFault propagate it past the action catches');
        assert.match(err.message, /getLatestPrice/, 'the deferral names its read site');
        assert.strictEqual(db.indexer.priceBarrierForceBlock, 1251,
            'the retry must be forced to take the barrier, or the block loops forever');
    });

    it('2. does NOT fire inside a DRY-RUN context, and writes no block-loop state', () => {
        const db  = stubDb();
        const err = capture(() =>
            db.runInDryRunEpoch(7, () => db._assertPriceBarrierNotSkipped('getLatestPrice')));

        assert.strictEqual(err, null,
            'a fee-quote dry run commits nothing, so an uncovered mirror read is harmless here; '
            + 'an unscoped barrier throws here and the wallet reports a fee-price outage');
        assert.strictEqual(db.indexer.priceBarrierForceBlock, null,
            'THE SECURITY HALF: a public unauthenticated read must not force a block-loop retry');
    });

    it('3. does NOT fire with no context at all (API / healthcheck read)', () => {
        const db = stubDb();
        assert.strictEqual(capture(() => db._assertPriceBarrierNotSkipped('getLatestPrice')), null);
        assert.strictEqual(db.indexer.priceBarrierForceBlock, null);
    });

    it('4. does NOT fire in a block-loop context when the block took the barrier', () => {
        const db = stubDb({ barrierSkipped: false });
        assert.strictEqual(
            capture(() => db.runInTxEpoch(7, () => db._assertPriceBarrierNotSkipped('getLatestPrice'))),
            null);
        assert.strictEqual(db.indexer.priceBarrierForceBlock, null);
    });

    it('5. M-16 is unweakened: a stale epoch inside a DRY-RUN context still fences', () => {
        const db  = stubDb({ epoch: 9 });
        const err = capture(() => db.runInDryRunEpoch(7, () => db._assertTxNotFenced()));

        assert.ok(err, 'the dry run installs its context precisely to get this fence');
        assert.match(err.message, /transaction fenced \(M-16\)/);
    });

    it('6. M-16 is unweakened: a stale epoch inside a BLOCK-LOOP context still fences', () => {
        const db  = stubDb({ epoch: 9 });
        const err = capture(() => db.runInTxEpoch(7, () => db._assertTxNotFenced()));

        assert.ok(err);
        assert.match(err.message, /transaction fenced \(M-16\)/);
    });

    it('7. the fee-quote dry run is the only caller that opts out of consensus', () => {
        // Structural, because the defect was a call site rather than a branch: a new
        // caller reaching for the fence must get `runInTxEpoch` and therefore stay
        // fail-closed on the barrier. If a second opt-out is ever legitimate, it is
        // added here deliberately rather than arriving unnoticed.
        const fs      = require('fs');
        const path    = require('path');
        const srcDir  = path.join(__dirname, '..', '..', 'src');
        const optOuts = [];

        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!entry.name.endsWith('.js')) continue;
                if (full.endsWith(path.join('src', 'db.js'))) continue; // the definition itself
                const text = fs.readFileSync(full, 'utf8');
                text.split('\n').forEach((line, i) => {
                    if (/\.runInDryRunEpoch\s*\(/.test(line))
                        optOuts.push(path.relative(srcDir, full) + ':' + (i + 1));
                });
            }
        })(srcDir);

        assert.deepStrictEqual(optOuts, ['actions.js:909', 'actions.js:927'],
            'unexpected consensus opt-out(s), or the known two moved: ' + optOuts.join(', '));
    });
});
