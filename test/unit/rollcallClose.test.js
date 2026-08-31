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
 * The ROLLCALL epoch close: quorum gate, absence pinning, the K-streak and
 * eviction (§3.4).
 *
 * WHAT THESE TESTS ARE FOR. An absence costs a live validator its stake, so
 * every case where the close could be WRONG matters more than the case where it
 * works. The happy path is a handful of these; the rest are refusals, skips and
 * deferrals. In particular the K-streak has two opposite failure modes and both
 * are driven here: ending a streak that should have continued (a source dodges
 * eviction forever by dipping under the floor), and continuing one that should
 * have ended (a validator that was demonstrably present gets evicted).
 *
 ********************************************************************/
const assert = require('assert');
const crypto = require('crypto');

const rc  = require('../../src/rollcall_close.js');
const rca = require('../../src/rollcall_activation.js');
const eq  = require('../../src/equivocation_header.js');
const { RollcallProofUnavailableError } = require('../../src/rollcall_proof_client.js');

const NETWORK = 'regtest';
const EPOCH   = 30;                                    // ROLLCALL_INTERVAL_BLOCKS.regtest
const WINDOW  = rca.ROLLCALL_ACCEPT_WINDOW_BLOCKS[NETWORK];
const CLOSE   = rca.rollcallCloseHeight(EPOCH, NETWORK);
const LEDGER  = 'ab'.repeat(32);

const CONFIG = {
    COIN: 'BTC', NETWORK: NETWORK,
    STAKING: { COOLDOWN_BLOCKS: 100, ACTIVATION_DELAY_BLOCKS: 6 }
};

// Minimal amount math, matching the indexer utility's contract for what the close uses.
const UTIL = {
    bcformat: (v, d) => Number(v).toFixed(d),
    bcgt:     (a, b) => Number(a) > Number(b)
};

// A real Ed25519 identity: the close verifies signatures for real, so the tests
// produce real ones. A fixture of canned hex would only prove the fixture.
function identity(){
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let raw = publicKey.export({ format: 'der', type: 'spki' }).slice(12).toString('hex');
    return { pubkey: raw, priv: privateKey };
}

function canonicalFor(epochHeight, ledgerHash){
    return Buffer.from(eq.buildEquivCanonical(
        eq.ENGINE_TAGS.ROLLCALL, String(epochHeight), 0,
        NETWORK + '|' + epochHeight + '|' + ledgerHash), 'utf8');
}

function signFor(id, epochHeight, ledgerHash){
    return crypto.sign(null, canonicalFor(epochHeight, ledgerHash), id.priv).toString('hex');
}

// A stub db recording every write the close makes. Only the methods the close
// actually calls are implemented, so an unexpected call fails loudly rather than
// silently returning undefined.
function stubDb(over){
    let db = {
        writes: { rollcalls: [], absences: [], unstakes: [], rewards: [], stakeStamps: [], delegationStamps: [], actionIndexes: [] },

        responsible: [],
        blocks: {},
        rolledEpochs: [],
        absencesBySource: {},
        sweepable: {},
        rewardResult: true,

        async getStakeWeightsByCapability(){ let r = this.responsible.slice(); r.truncated = this.responsible.truncated; return r; },
        async getStoredBlockHashes(h){ return this.blocks[h] || null; },
        async insertRollcall(e, s, c, rolled, pinned){ this.writes.rollcalls.push({ e, s, c, rolled, pinned }); return true; },
        async insertRollcallAbsences(rows){ this.writes.absences.push(...rows); return rows.length; },
        async getRolledRollcallEpochs(){ return this.rolledEpochs; },
        async getRollcallAbsenceEpochsForSource(src){ return this.absencesBySource[src] || []; },
        sweepCalls: [],
        async getSweepableStakeBySource(src, blk, includePending){
            this.sweepCalls.push({ src, blk, includePending });
            return this.sweepable[src] || [];
        },
        async createActionIndex(d){ let i = 9000 + this.writes.actionIndexes.length; this.writes.actionIndexes.push(Object.assign({ index: i }, d)); return i; },
        async createUnstake(d){ this.writes.unstakes.push(d); return true; },
        async setStakeDeactivationBySourceAndPubkey(src, pk, blk, cur, pending){ this.writes.stakeStamps.push({ src, pk, blk, pending }); return true; },
        async setAllDelegationDeactivationsBySource(src, blk){ this.writes.delegationStamps.push({ src, blk }); return 1; },
        async createValidatorReward(pk, ref, type, amt, blk, upsert, derive, qual){
            this.writes.rewards.push({ pk, ref, type, amt, blk, derive, qual });
            return this.rewardResult;
        }
    };
    return Object.assign(db, over || {});
}

// A proof client returning a canned decided/undecided answer.
function stubProof(answer){
    return { async fetchSigners(){ return answer; } };
}

// Build a federation of `n` sources, each with one key, all weight 1000.
function federation(n){
    let ids = [], responsible = [];
    for(let i = 0; i < n; i++){
        let id = identity();
        ids.push(id);
        responsible.push({ pubkey: id.pubkey, source: 'src' + i, weight: '1000.00000000' });
    }
    return { ids, responsible };
}

// A decided answer in which `presentIdx` signed for real.
function answerWith(fed, presentIdx, over){
    let signers = {};
    for(let i of presentIdx){
        signers[fed.ids[i].pubkey] = {
            sig:          signFor(fed.ids[i], EPOCH, LEDGER),
            ledger_hash:  LEDGER,
            publisher:    fed.ids[0].pubkey,
            action_index: 1, block_index: 10
        };
    }
    return Object.assign({ decided: true, hcut: 50, signers, publishers: {} }, over || {});
}

function dbFor(fed, over){
    let db = stubDb(over);
    db.responsible = fed.responsible;
    db.blocks[EPOCH]          = { ledger_hash: LEDGER, block_time: 500 };
    db.blocks[EPOCH + WINDOW] = { ledger_hash: 'cd'.repeat(32), block_time: 900 };
    return db;
}

describe('ROLLCALL epoch close (§3.4)', function(){

    // The close returns 0 immediately below activation, so on an inert network every
    // assertion here would pass by doing nothing. Regtest went INERT on 2026-08-31
    // (a single-coin BTC regtest venue has no DOGE peer to prove a close), so the
    // suite arms it for its own duration and restores it after. Regtest stays the
    // right target: its 30/12/2 cadence is the short-interval case, and the live
    // networks' 1008/144/36 would need epoch heights in the hundreds of thousands.
    let savedActivation;
    before(function(){
        savedActivation = rca.ROLLCALL_ACTIVATION[NETWORK];
        rca.ROLLCALL_ACTIVATION[NETWORK] = 0;
    });
    after(function(){ rca.ROLLCALL_ACTIVATION[NETWORK] = savedActivation; });

    describe('when the close does not run at all', function(){

        it('is a no-op off BTC, where no stake row lives', async function(){
            let db = dbFor(federation(3));
            let n = await rc.closeRollcallEpochs(db, { COIN: 'DOGE', NETWORK }, CLOSE, stubProof(null), UTIL);
            assert.strictEqual(n, 0);
            assert.strictEqual(db.writes.rollcalls.length, 0);
        });

        it('is a no-op at a block that closes no epoch', async function(){
            let db = dbFor(federation(3));
            let n = await rc.closeRollcallEpochs(db, CONFIG, CLOSE + 1, stubProof(null), UTIL);
            assert.strictEqual(n, 0);
            assert.strictEqual(db.writes.rollcalls.length, 0);
        });
    });

    describe('deferral: every way of not knowing', function(){

        it('defers when the DOGE peer cannot decide, rather than reading silence as absence', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            await assert.rejects(
                () => rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof({ decided: false, reason: 'unreachable' }), UTIL),
                (e) => e instanceof RollcallProofUnavailableError && /unreachable/.test(e.message));
            // The critical assertion: nothing was written. A deferred block must leave
            // no verdict behind, or the retry would double-write it.
            assert.strictEqual(db.writes.rollcalls.length, 0);
            assert.strictEqual(db.writes.absences.length, 0);
        });

        it('defers when the window-end block has no stored block_time', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            delete db.blocks[EPOCH + WINDOW];
            await assert.rejects(
                () => rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL),
                RollcallProofUnavailableError);
        });

        it('defers when the epoch block has no stored ledger_hash', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            delete db.blocks[EPOCH];
            await assert.rejects(
                () => rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL),
                RollcallProofUnavailableError);
        });
    });

    describe('the quorum gate: an unrolled epoch counts for nobody', function(){

        it('writes an unrolled row and NO absences when the responsible read was truncated', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            db.responsible.truncated = true;
            let n = await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [])), UTIL);
            assert.strictEqual(n, 1);
            assert.strictEqual(db.writes.rollcalls[0].rolled, 0);
            assert.strictEqual(db.writes.rollcalls[0].pinned, null);
            assert.strictEqual(db.writes.absences.length, 0);
        });

        it('writes an unrolled row and NO absences when the federation is empty', async function(){
            let db = dbFor({ ids: [], responsible: [] });
            let n  = await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(null), UTIL);
            assert.strictEqual(n, 1);
            assert.strictEqual(db.writes.rollcalls[0].rolled, 0);
            assert.strictEqual(db.writes.absences.length, 0);
        });

        it('evicts NOBODY when the present set is below threshold, however many are absent', async function(){
            let fed = federation(4);
            let db  = dbFor(fed);
            // One of four present: nowhere near 2/3 by weight.
            let n = await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0])), UTIL);
            assert.strictEqual(n, 1);
            assert.strictEqual(db.writes.rollcalls[0].rolled, 0);
            assert.strictEqual(db.writes.absences.length, 0, 'an unrolled epoch pins no absence');
            assert.strictEqual(db.writes.unstakes.length, 0);
            assert.strictEqual(db.writes.rewards.length, 0, 'an unrolled epoch pays no publish reward');
        });
    });

    describe('verification: only signatures bound to THIS chain count', function(){

        it('does not count a signature bound to a different ledger_hash', async function(){
            let fed = federation(4);
            let db  = dbFor(fed);
            // All three "signed", but one signed over a DIFFERENT epoch block. That is a
            // signature about a chain this node is not on, and it must not count as presence.
            let a = answerWith(fed, [0, 1, 2]);
            let wrong = 'ff'.repeat(32);
            a.signers[fed.ids[3].pubkey] = {
                sig: signFor(fed.ids[3], EPOCH, wrong), ledger_hash: wrong,
                publisher: fed.ids[0].pubkey, action_index: 1, block_index: 10
            };
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL);
            let absent = db.writes.absences.map((r) => r.source);
            assert.deepStrictEqual(absent, ['src3'], 'the wrongly-bound signer is absent, not present');
        });

        it('does not count a well-formed signature that simply does not verify', async function(){
            let fed = federation(4);
            let db  = dbFor(fed);
            let a = answerWith(fed, [0, 1, 2]);
            a.signers[fed.ids[3].pubkey] = {
                sig: '11'.repeat(64), ledger_hash: LEDGER,
                publisher: fed.ids[0].pubkey, action_index: 1, block_index: 10
            };
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL);
            assert.deepStrictEqual(db.writes.absences.map((r) => r.source), ['src3']);
        });

        it('does not count a VALID signature whose row mislabels the ledger_hash', async function(){
            // The strictness §3.4 step 3 asks for, and it is not redundant with the
            // signature check: this signature verifies perfectly over this indexer's own
            // canonical, and only the row's carried ledger_hash field disagrees. The row
            // must be internally consistent to count, so a mislabeled row is discarded
            // rather than quietly accepted on the strength of its signature.
            let fed = federation(4);
            let db  = dbFor(fed);
            let a = answerWith(fed, [0, 1, 2]);
            a.signers[fed.ids[3].pubkey] = {
                sig:         signFor(fed.ids[3], EPOCH, LEDGER),   // valid over OUR canonical
                ledger_hash: 'ff'.repeat(32),                      // but the row says otherwise
                publisher:   fed.ids[0].pubkey, action_index: 1, block_index: 10
            };
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL);
            assert.deepStrictEqual(db.writes.absences.map((r) => r.source), ['src3'],
                'an internally inconsistent row is not a presence proof');
        });

        it('rolls and pins no absence when every source is present', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL);
            assert.strictEqual(db.writes.rollcalls[0].rolled, 1);
            // The close hands db.insertRollcall the source ARRAY; the JSON encoding is
            // the db layer's job, so this asserts the contract the close actually has.
            assert.deepStrictEqual(db.writes.rollcalls[0].pinned.slice().sort(), ['src0','src1','src2']);
            assert.strictEqual(db.writes.absences.length, 0);
        });
    });

    describe('the K-streak', function(){

        // A rolled lookback window, newest first, each epoch pinning the given sources.
        function lookback(epochs){
            return epochs.map((e) => ({
                epoch_height: e.h,
                responsible_set_json: e.pinned === null ? null : JSON.stringify(e.pinned)
            }));
        }

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

        it('ENDS the streak on a demonstrated presence, so a recovered validator is never evicted', async function(){
            // This is AT2's shape: absent, then present, then absent. The middle epoch
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

    describe('the eviction effect', function(){

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

    describe('the publish reward', function(){

        it('pays the ELECTED leader, at the earn/materialisation heights the rollback keys on', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            let leader = rc.hashOrder(rc.electionKey(NETWORK, EPOCH), fed.responsible.map((r) => r.pubkey))[0];
            let a = answerWith(fed, [0,1,2]);
            a.publishers[leader] = { action_index: 1, block_index: 10 };
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL);
            assert.strictEqual(db.writes.rewards.length, 1);
            let r = db.writes.rewards[0];
            assert.strictEqual(r.pk, leader);
            assert.strictEqual(r.type, 'rollcall_publish');
            assert.strictEqual(r.amt, rca.ROLLCALL_REWARD_AMOUNT);
            assert.strictEqual(r.ref, EPOCH,    'round_reference is the epoch');
            assert.strictEqual(r.blk, EPOCH,    'block_index is the EARN block');
            assert.strictEqual(r.derive, CLOSE, 'derive_block_index is the close, so a reorg into (E, C] deletes it');
            assert.strictEqual(r.qual, 0);
        });

        it('pays nothing when the leader published nothing', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL);
            assert.strictEqual(db.writes.rewards.length, 0);
        });

        it('throws rather than silently skipping a refused reward write', async function(){
            // createValidatorReward returns false when its active-stake precondition
            // fails. The leader is in R(E) by construction, so a false here means the
            // node disagrees with its peers about the set: better to halt than to
            // derive a reward set nobody else has.
            let fed = federation(3);
            let db  = dbFor(fed);
            db.rewardResult = false;
            let leader = rc.hashOrder(rc.electionKey(NETWORK, EPOCH), fed.responsible.map((r) => r.pubkey))[0];
            let a = answerWith(fed, [0,1,2]);
            a.publishers[leader] = { action_index: 1, block_index: 10 };
            await assert.rejects(
                () => rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL),
                /reward write refused/);
        });
    });

    describe('leader election parity', function(){

        it('orders by sha256(key || pubkey) ascending, the hub\'s own ordering', async function(){
            // Byte-parity with StateAnchorPublisher.hashOrder. If these diverge, the BTC
            // side pays a validator the federation did not elect.
            let keys = Array.from({ length: 8 }, () => crypto.randomBytes(32).toString('hex'));
            let key  = rc.electionKey(NETWORK, EPOCH);
            let expected = keys.slice().map((pk) => ({
                pubkey: pk.toLowerCase(),
                hash: crypto.createHash('sha256').update(key, 'utf8').update(pk.toLowerCase(), 'utf8').digest('hex')
            })).sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0)).map((e) => e.pubkey);
            assert.deepStrictEqual(rc.hashOrder(key, keys), expected);
        });

        it('carries its own domain tag, so the anchor election and this one are independent', function(){
            assert.strictEqual(rc.electionKey('regtest', 30), 'XROLLCALL|regtest|30');
        });
    });
});
