/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Part of the ROLLCALL epoch close suite whose entry is
 * test/unit/rollcall_close.test.js: the K-streak, both of its failure modes,
 * and the eviction effect a completed streak has. Every block repeats the
 * suite title, so each full test title is unchanged.
 *
 ********************************************************************/
const assert = require('assert');
const rc  = require('../../../src/consensus/rollcall_close.js');
const rca = require('../../../src/rollcall_activation.js');

const { EPOCH, CLOSE, CONFIG, UTIL, stubProof, federation, answerWith, dbFor, armRollcall } = require('./helpers/rollcall_fixtures.js');

// A rolled lookback window, newest first, each epoch pinning the given sources.
function lookback(epochs){
    return epochs.map((e) => ({
        epoch_height: e.h,
        responsible_set_json: e.pinned === null ? null : JSON.stringify(e.pinned)
    }));
}

// One close that evicts src3, absent for K consecutive rolled epochs with stake
// left to sweep, for the blocks that assert what an eviction writes.
async function evictOne(){
    let fed = federation(4);
    let db  = dbFor(fed);
    db.rolledEpochs = [
        { epoch_height: EPOCH,      responsible_set_json: JSON.stringify(['src0','src1','src2','src3']) },
        { epoch_height: EPOCH - 30, responsible_set_json: JSON.stringify(['src0','src1','src2','src3']) }
    ];
    db.absencesBySource['src3'] = [EPOCH - 30];
    db.sweepable['src3'] = [{ signing_pubkey: fed.ids[3].pubkey, amount: '25000.00000000' }];
    await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL);
    return { db, fed };
}

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('the K-streak', function(){
        it('does not evict on a first absence', async function(){
            let fed = federation(4);
            let db  = dbFor(fed);
            db.rolledEpochs = lookback([{ h: EPOCH, pinned: ['src0','src1','src2','src3'] }]);
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL);
            assert.strictEqual(db.writes.absences.length, 1);
            assert.strictEqual(db.writes.absences[0].evicted, false);
            assert.strictEqual(db.writes.unstakes.length, 0);
        });

        it('evicts once the absence reaches K consecutive rolled epochs', async function(){
            let fed = federation(4);
            let db  = dbFor(fed);
            db.rolledEpochs = lookback([
                { h: EPOCH,      pinned: ['src0','src1','src2','src3'] },
                { h: EPOCH - 30, pinned: ['src0','src1','src2','src3'] }
            ]);
            db.absencesBySource['src3'] = [EPOCH - 30];
            db.sweepable['src3'] = [{ signing_pubkey: fed.ids[3].pubkey, amount: '25000.00000000' }];
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL);
            assert.strictEqual(db.writes.absences[0].evicted, true);
            assert.strictEqual(db.writes.unstakes.length, 1);
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('the K-streak', function(){
        it('ENDS the streak on a demonstrated presence, so a recovered validator is never evicted', async function(){
            // This is the flaky-hub shape: absent, then present, then absent. The middle epoch
            // must break the streak, or an intermittent hub is evicted for being flaky.
            let fed = federation(4);
            let db  = dbFor(fed);
            db.rolledEpochs = lookback([
                { h: EPOCH,      pinned: ['src0','src1','src2','src3'] },
                { h: EPOCH - 30, pinned: ['src0','src1','src2','src3'] },   // in R, no absence row => present
                { h: EPOCH - 60, pinned: ['src0','src1','src2','src3'] }
            ]);
            db.absencesBySource['src3'] = [EPOCH - 60];
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL);
            assert.strictEqual(db.writes.absences[0].evicted, false, 'presence must end the streak');
            assert.strictEqual(db.writes.unstakes.length, 0);
        });

        it('SKIPS an epoch the source was not responsible for, so dipping under the floor is no escape (D39)', async function(){
            // The dodge this closes: drop under the capability floor for one epoch with a
            // partial UNSTAKE, so the source is not in R and pins no absence, then top back
            // up. If that epoch ended the streak, a validator could stay idle forever.
            let fed = federation(4);
            let db  = dbFor(fed);
            db.rolledEpochs = lookback([
                { h: EPOCH,      pinned: ['src0','src1','src2','src3'] },
                { h: EPOCH - 30, pinned: ['src0','src1','src2'] },          // src2 NOT in R: skipped
                { h: EPOCH - 60, pinned: ['src0','src1','src2','src3'] }    // absent here
            ]);
            db.absencesBySource['src3'] = [EPOCH - 60];
            db.sweepable['src3'] = [{ signing_pubkey: fed.ids[3].pubkey, amount: '25000.00000000' }];
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL);
            assert.strictEqual(db.writes.absences[0].evicted, true,
                'a skipped epoch must not end the streak');
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('the K-streak', function(){
        it('stops the walk on an unreadable pin rather than skipping it', async function(){
            // A null/unparseable pin means membership cannot be judged at that epoch.
            // Skipping it would silently treat the source as not-in-R and let the streak
            // reach back further than the evidence supports.
            let fed = federation(4);
            let db  = dbFor(fed);
            db.rolledEpochs = lookback([
                { h: EPOCH,      pinned: ['src0','src1','src2','src3'] },
                { h: EPOCH - 30, pinned: null },
                { h: EPOCH - 60, pinned: ['src0','src1','src2','src3'] }
            ]);
            db.absencesBySource['src3'] = [EPOCH - 60];
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL);
            assert.strictEqual(db.writes.absences[0].evicted, false);
        });

        it('never reaches past the lookback window', async function(){
            assert.strictEqual(rca.ROLLCALL_STREAK_LOOKBACK, 2 * rca.ROLLCALL_EVICT_MISSES,
                'the lookback is 2K by construction');
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('the eviction effect', function(){
        it('mints a synthetic UNSTAKE at FORMAT 3, the eviction marker', async function(){
            let { db } = await evictOne();
            assert.strictEqual(db.writes.actionIndexes.length, 1);
            assert.strictEqual(db.writes.actionIndexes[0].ACTION, 'UNSTAKE');
            assert.strictEqual(db.writes.actionIndexes[0].FORMAT, 3);
            assert.strictEqual(db.writes.actionIndexes[0].BLOCK_INDEX, CLOSE);
        });

        it('refunds through an ordinary unstakes row on the ordinary cooldown', async function(){
            let { db } = await evictOne();
            let u = db.writes.unstakes[0];
            assert.strictEqual(u.SOURCE, 'src3');
            assert.strictEqual(u.STATUS, 'valid');
            assert.strictEqual(u.BLOCK_INDEX, CLOSE);
            assert.strictEqual(u.COOLDOWN_END_BLOCK, CLOSE + CONFIG.STAKING.COOLDOWN_BLOCKS,
                'deactivation, not a burn: the stake refunds after the ordinary cooldown');
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('the eviction effect', function(){
        it('stamps the stake SOURCE-SCOPED and sweeps pending rows', async function(){
            let { db } = await evictOne();
            let s = db.writes.stakeStamps[0];
            assert.strictEqual(s.src, 'src3', 'scoped to the source, not just the key');
            assert.strictEqual(s.blk, CLOSE + CONFIG.STAKING.ACTIVATION_DELAY_BLOCKS);
            assert.strictEqual(s.pending, true, 'a top-up must not walk the source back in');
        });

        it('READS the pending rows too, not just the activated ones', async function(){
            // An eviction is a removal, not an amount. If the sweep asked only for
            // activated rows, a 1-XCHAIN top-up landed just before the epoch would
            // survive the eviction and walk the source straight back into the set.
            let { db } = await evictOne();
            assert.strictEqual(db.sweepCalls.length, 1);
            assert.strictEqual(db.sweepCalls[0].includePending, true,
                'the sweep must include pending-activation rows');
        });

        it('stamps every delegation of the source, or the DELEGATE branch keeps it in', async function(){
            let { db } = await evictOne();
            assert.deepStrictEqual(db.writes.delegationStamps,
                [{ src: 'src3', blk: CLOSE + CONFIG.STAKING.ACTIVATION_DELAY_BLOCKS }]);
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('the eviction effect', function(){
        it('is a no-op when a real UNSTAKE already swept the source', async function(){
            let fed = federation(4);
            let db  = dbFor(fed);
            db.rolledEpochs = [
                { epoch_height: EPOCH,      responsible_set_json: JSON.stringify(['src0','src1','src2','src3']) },
                { epoch_height: EPOCH - 30, responsible_set_json: JSON.stringify(['src0','src1','src2','src3']) }
            ];
            db.absencesBySource['src3'] = [EPOCH - 30];
            db.sweepable['src3'] = [];                       // nothing left to sweep
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL);
            assert.strictEqual(db.writes.unstakes.length, 0);
            assert.strictEqual(db.writes.delegationStamps.length, 0);
        });
    });
});
