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
 * The fixtures every part of the ROLLCALL epoch close suite drives the close
 * with: real Ed25519 identities and signatures over the v0 and v1 canonicals,
 * a stub db that records every write, a canned proof client, and the hook pair
 * that arms ROLLCALL for each block of the suite. The suite itself is
 * test/unit/rollcall_close.test.js and the parts beside it.
 *
 ********************************************************************/
const crypto = require('crypto');

const rca = require('../../../../../src/rollcall_activation.js');
const eq  = require('../../../../../src/equivocation_header.js');

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

// The ROLLCALL v1 canonical, spelled out here rather than imported from
// rollcall_canonical.js: a test that signed with the same helper the close
// verifies with would agree with it however wrong both were. This is the
// independent statement of the bytes, `network|epoch|ledger|sha256(GATES)`
// inside the same equivocation header v0 always used.
function canonicalV1For(epochHeight, ledgerHash, gates){
    let gh = crypto.createHash('sha256').update(String(gates), 'utf8').digest('hex');
    return Buffer.from(eq.buildEquivCanonical(
        eq.ENGINE_TAGS.ROLLCALL, String(epochHeight), 0,
        NETWORK + '|' + epochHeight + '|' + ledgerHash + '|' + gh), 'utf8');
}

function signV1For(id, epochHeight, ledgerHash, gates){
    return crypto.sign(null, canonicalV1For(epochHeight, ledgerHash, gates), id.priv).toString('hex');
}

// A stub db recording every write the close makes. Only the methods the close
// actually calls are implemented, so an unexpected call fails loudly rather than
// silently returning undefined.
function stubDb(over){
    let db = {
        writes: { rollcalls: [], absences: [], unstakes: [], rewards: [], stakeStamps: [], delegationStamps: [], actionIndexes: [], gates: [] },

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
        async insertRollcallGates(e, c, rows){ this.writes.gates.push({ e, c, rows }); return rows.length; },
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

// The close returns 0 immediately below activation, so on an inert network every
// assertion here would pass by doing nothing. Regtest went INERT on 2026-08-31
// (a single-coin BTC regtest venue has no DOGE peer to prove a close), so the
// suite arms it for its own duration and restores it after. Regtest stays the
// right target: its 30/12/2 cadence is the short-interval case, and the live
// networks' 1008/144/36 would need epoch heights in the hundreds of thousands.
function armRollcall(){
    let savedActivation;
    before(function(){
        savedActivation = rca.ROLLCALL_ACTIVATION[NETWORK];
        rca.ROLLCALL_ACTIVATION[NETWORK] = 0;
    });
    after(function(){ rca.ROLLCALL_ACTIVATION[NETWORK] = savedActivation; });
}

module.exports = {
    NETWORK, EPOCH, WINDOW, CLOSE, LEDGER, CONFIG, UTIL,
    identity, canonicalFor, signFor, canonicalV1For, signV1For,
    stubDb, stubProof, federation, answerWith, dbFor, armRollcall
};
