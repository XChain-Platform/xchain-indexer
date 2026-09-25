'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The database stubs the AnchorRecovery suites drive recovery against: the DOGE
// indexer's anchor_actions / cross_chain_* query surface, the BTC indexer's stake
// and capability resolvers, and the BTC reward staging table. They live here
// because test/unit/recovery/recovery.test.js and the parts under test/unit/recovery/recovery.test/ all
// feed the same archives through them, so one copy keeps every part judging
// recovery against the same model of the schema.

const assert = require('assert');

const Utility = require('../../src/utility.js');

// Stake-weighted quorum is active for every regtest snapshot_block
// (STAKE_WEIGHTED_QUORUM_ACTIVATION.regtest = 0), so recovery takes the weighted
// predicate, which needs the indexer's bcmath. Each archived snapshot below
// carries a DISTINCT source at equal weight, so the source-deduped threshold
// (3·Σweight > 2·S) reduces to the legacy 2f+1 signer count.
const util = new Utility();

// The address every fixture anchor is authored by, i.e. the archive head's SOURCE
// A chunk is only counted when it shares the canonical head's author, so
// fixtures that omit `source` on either side are treated as this one and behave exactly
// as they did before the authorship filter existed.
const AUTHOR   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const OUTSIDER = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef';

// DOGE height a fixture archive head landed at (anchor_actions.block_index_doge). Only
// the cases set it: the publisher-scoped rule is armed on regtest from genesis
// so a head that carries one is judged under it while the older fixtures - which model
// batches with a single publisher, where both rules select the same head - stay on the
// canonical-head path and keep asserting exactly what they always did.
const ARMED_DOGE_BLOCK = 500;

/**
 * The archive-head reads of memDb's doQuery: the replay driver's v1 select and
 * the batch's canonical head. Returns undefined for any other statement.
 */
function archiveHeadRows(v1s, sql, params) {
    // recovery.run() now joins index_statuses and restricts to status IN
    // ('valid','unverified'), matching getArchiveReplayWatermarks. Model that here: a fixture
    // row's optional `status` property drives the filter (absent = 'valid', so the
    // pre-existing fixtures are unaffected). A row parsed as invalid is excluded, exactly
    // as the INNER JOIN + status set drops it against the real schema.
    // Matched on the leading `SELECT a.*` rather than a literal prefix
    // LEFT-joined the head's author into the driver's select list (recovery must
    // reassemble the same publisher-scoped chunk set the live path did), which a
    // literal prefix match would have silently stopped recognizing.
    if (/^SELECT a\.\*/.test(String(sql).replace(/\s+/g, ' ').trim())) {
        return v1s.filter(v => {
            let st = (v.status == null) ? 'valid' : String(v.status);
            return st === 'valid' || st === 'unverified';
        }).map(v => Object.assign({ source: AUTHOR }, v));
    }
    // flag-day anchor: the batch's CANONICAL head (earliest v1/v6 row for
    // the seq, status-agnostic), reduced to the DOGE height that decides whether
    // the batch is publisher-scoped. That is block_index_doge (where the ANCHOR
    // landed), never block_index (the CHECKPOINTED height on the checkpointed
    // chain). A fixture head without one leaves the rule inert, which is how the
    // pre- cases below keep asserting the canonical-head behavior.
    if (String(sql).replace(/\s+/g, ' ').trim().startsWith('SELECT h.action_index, h.block_index_doge')) {
        let head = v1s
            .filter(v => Number(v.match_batch_seq) === Number(params[0]))
            .sort((a, b) => Number(a.action_index || 0) - Number(b.action_index || 0))[0];
        return head ? [{ action_index: head.action_index, block_index_doge: head.block_index_doge }] : [];
    }
    return undefined;
}

/**
 * The archive-chunk read of memDb's doQuery: the chunk set one head reassembles.
 * Returns undefined for any other statement.
 */
function archiveChunkRows(v1s, v2s, sql, params) {
    // The chunk query joins index_statuses and drops rejected rows
    // (status LIKE 'invalid:%'), keeping 'valid' and 'orphan', and
    // also drops every chunk not authored by the batch's CANONICAL archive
    // head (earliest v1/v6 row by action_index, status-agnostic). Model both
    // filters here; recovery's own JS does the per-index dedupe. Fixture rows
    // default to AUTHOR on both sides, so fixtures older than the authorship filter are unaffected.
    // Whitespace-normalized: the query is no longer a local one-liner but the
    // shared ARCHIVE_CHUNK_SET_SQL constant, which is indented across lines.
    // added a second shape with the SAME select list: the author is a bound
    // parameter (publisher-scoped batch) instead of the canonical-head subquery,
    // so the two are told apart by the predicate, not the prefix.
    if (String(sql).replace(/\s+/g, ' ').trim()
            .startsWith('SELECT c.*, cadr.address AS source FROM anchor_actions c')) {
        let scoped = /cadr\.address\s*=\s*\?/.test(String(sql));
        let head = v1s
            .filter(v => Number(v.match_batch_seq) === Number(params[0]))
            .sort((a, b) => Number(a.action_index || 0) - Number(b.action_index || 0))[0];
        let headAuthor = scoped
            ? params[1]
            : (head ? (head.source === undefined ? AUTHOR : head.source) : null);
        return v2s
            .filter(c => Number(c.match_batch_seq) === Number(params[0]))
            .filter(c => !String(c.status == null ? 'valid' : c.status).startsWith('invalid:'))
            .filter(c => headAuthor !== null && headAuthor !== undefined &&
                         (c.source === undefined ? AUTHOR : c.source) === headAuthor)
            .sort((a, b) => (Number(a.chunk_index) - Number(b.chunk_index)) ||
                            (Number(a.action_index || 0) - Number(b.action_index || 0)));
    }
    return undefined;
}

/**
 * The capability_snapshots and cross_chain_matches statements of memDb's
 * doQuery, applied to the stub's rows. Returns undefined for any other statement.
 */
function matchRows(matches, snapshots, sql, params) {
    if (sql.startsWith('INSERT IGNORE INTO capability_snapshots')) {
        let [snapshot_block, capability, signing_pubkey, amount] = params;
        if (!snapshots.some(r => r.snapshot_block === snapshot_block && r.capability === capability && r.signing_pubkey === signing_pubkey))
            snapshots.push({ snapshot_block, capability, signing_pubkey, amount });
        return [];
    }
    if (sql.startsWith('SELECT match_id FROM cross_chain_matches'))
        return matches.filter(r => r.match_id === params[0]).map(r => ({ match_id: r.match_id }));
    if (sql.startsWith('UPDATE cross_chain_matches SET status')) {
        if (sql.includes('effective_time')) {
            // Revive content upgrade. params = [status, effective_time,
            // finalizing_view, validator_signatures, anchorTxid, match_id].
            for (let r of matches) if (r.match_id === params[5]) {
                r.status               = params[0];
                r.effective_time       = params[1];
                r.finalizing_view      = params[2];
                r.validator_signatures = params[3];
                if (r.anchor_txid == null) r.anchor_txid = params[4];
            }
            return [];
        }
        // Status-only update (non-finalized incoming). params = [status, anchorTxid,
        // match_id]; anchor_txid upgrades NULL->value only (COALESCE semantics).
        for (let r of matches) if (r.match_id === params[2]) {
            r.status = params[0];
            if (r.anchor_txid == null) r.anchor_txid = params[1];
        }
        return [];
    }
    if (sql.startsWith('INSERT INTO cross_chain_matches')) {
        // Positional per recovery's INSERT (no id column in these fixtures): the
        // royalty columns sit at 11 (a_payout_legs) / 20 (b_payout_legs), status at 23;
        // anchor_txid is the last param, finalizing_view second-to-last.
        matches.push({ match_id: params[0], a_payout_legs: params[11], b_payout_legs: params[20],
                       effective_time: params[21], validator_signatures: params[22],
                       status: params[23], finalizing_view: params[params.length - 2],
                       anchor_txid: params[params.length - 1] });
        return [];
    }
    return undefined;
}

/**
 * The cross_chain_calls statements of memDb's doQuery, applied to the stub's
 * rows. Returns undefined for any other statement.
 */
function callRows(calls, sql, params) {
    // ── cross_chain_calls (XCALL relay rows; keyed on call_id + phase) ──
    if (sql.startsWith('SELECT call_id FROM cross_chain_calls'))
        return calls.filter(r => r.call_id === params[0] && r.phase === params[1]).map(r => ({ call_id: r.call_id }));
    if (sql.startsWith('UPDATE cross_chain_calls SET status')) {
        if (sql.includes('snapshot_block')) {
            // Finalized-wins full-column content upgrade (recovery.rebuild). Param order:
            // [0]=status, [12]=effective_time, [15]=validator_signatures, [16]=finalizing_view,
            // [17]=call_id, [18]=phase (mirrors the UPDATE column list).
            for (let r of calls) if (r.call_id === params[17] && r.phase === params[18]) {
                r.status = params[0];
                r.effective_time = params[12];
                r.validator_signatures = params[15];
                r.finalizing_view = params[16];
            }
            return [];
        }
        // Status-only update (non-finalized incoming): params = [status, call_id, phase].
        for (let r of calls) if (r.call_id === params[1] && r.phase === params[2]) r.status = params[0];
        return [];
    }
    if (sql.startsWith('INSERT INTO cross_chain_calls')) {
        // finalizing_view is the last bound value (after validator_signatures).
        calls.push({ id: params[0], call_id: params[1], phase: params[2],
                     effective_time: params[14], status: params[15],
                     validator_signatures: params[18], finalizing_view: params[params.length - 1] });
        return [];
    }
    return undefined;
}

function bridgePolicyRows(bridges, policies, sql, params) {
    if (sql.startsWith('SELECT transfer_id FROM bridge_transfers'))
        return bridges.filter(r => r.transfer_id === params[0]).map(r => ({ transfer_id: r.transfer_id }));
    if (sql.startsWith('UPDATE bridge_transfers SET status')) {
        for (let row of bridges) if (row.transfer_id === params[1]) row.status = params[0];
        return [];
    }
    if (sql.startsWith('INSERT INTO bridge_transfers')) {
        bridges.push({ id: params[0], transfer_id: params[1], snapshot_block: params[2], network: params[3],
                       src_chain: params[4], src_action_index: params[5], src_address: params[6],
                       dest_chain: params[7], dest_address: params[8], tick: params[9], decimals: params[10],
                       amount: params[11], effective_time: params[12], admit_block_btc: params[13],
                       admit_block_ltc: params[14], admit_block_doge: params[15], finalizing_view: params[16],
                       validator_signatures: params[17], status: params[18] });
        return [];
    }
    if (sql.startsWith('SELECT snapshot_id FROM policy_snapshots WHERE snapshot_id'))
        return policies.filter(r => r.snapshot_id === params[0]).map(r => ({ snapshot_id: r.snapshot_id }));
    if (String(sql).replace(/\s+/g, ' ').trim().startsWith('SELECT snapshot_id FROM policy_snapshots WHERE network'))
        return policies.filter(r => r.network === params[0] && r.origin_chain === params[1] &&
            r.tick === params[2] && Number(r.policy_seq) === Number(params[3]))
            .map(r => ({ snapshot_id: r.snapshot_id }));
    if (sql.startsWith('INSERT IGNORE INTO policy_snapshots')) {
        policies.push({ id: params[0], snapshot_id: params[1], snapshot_block: params[2], network: params[3],
                        origin_chain: params[4], tick: params[5], policy_seq: params[6], origin_block: params[7],
                        policy_hash: params[8], allow_list: params[9], block_list: params[10], sleeping: params[11],
                        effective_time: params[12], admit_block_btc: params[13], admit_block_ltc: params[14],
                        admit_block_doge: params[15], finalizing_view: params[16],
                        validator_signatures: params[17], status: params[18] });
        return [];
    }
    return undefined;
}

/**
 * Give memDb's handle begin/commit/rollback over its three row arrays.
 * @returns {object} the same handle, now with a transaction API
 */
function withSnapshotTx(db, matches, snapshots, calls, bridges, policies) {
    let saved = null;
    const clone = (rows) => rows.map(r => Object.assign({}, r));
    const restore = (target, rows) => { target.length = 0; for (let r of rows) target.push(r); };
    // Snapshot/restore transaction semantics: enough to prove a rolled-back batch leaves
    // NOTHING behind, which is the whole point of the per-batch transaction.
    db.txDepth = 0;
    db.commits = 0;
    db.rollbacks = 0;
    db.beginTransaction = async function () {
        assert.strictEqual(db.txDepth, 0, 'recovery must not nest transactions on one handle');
        db.txDepth = 1;
        saved = { matches: clone(matches), snapshots: clone(snapshots), calls: clone(calls),
                  bridges: clone(bridges), policies: clone(policies) };
    };
    db.commitTransaction = async function () {
        assert.strictEqual(db.txDepth, 1, 'commit without an open transaction');
        db.txDepth = 0; db.commits++; saved = null;
    };
    db.rollbackTransaction = async function () {
        if (db.txDepth === 0) return;                     // no-op after a commit, like Database
        db.txDepth = 0; db.rollbacks++;
        restore(matches, saved.matches); restore(snapshots, saved.snapshots); restore(calls, saved.calls);
        restore(bridges, saved.bridges); restore(policies, saved.policies);
        saved = null;
    };
    return db;
}

// In-memory DOGE indexer DB for the recovery query surface.
// opts.noTx: expose ONLY doQuery, modelling a raw query handle with no transaction API
// (recovery must still rebuild against one; see the back-compat case below). Otherwise the
// stub implements begin/commit/rollback with snapshot semantics, so the per-batch
// transaction is exercised by every test in this file.
function memDb(v1s, v2s, opts) {
    opts = opts || {};
    let matches = [], snapshots = [], calls = [], bridges = [], policies = [];
    let db = {
        matches, snapshots, calls, bridges, policies,
        async doQuery(sql, params) {
            params = params || [];
            // Each statement family answers its own statements and passes on the rest.
            let rows = archiveHeadRows(v1s, sql, params);
            if (rows === undefined) rows = archiveChunkRows(v1s, v2s, sql, params);
            if (rows === undefined) rows = matchRows(matches, snapshots, sql, params);
            if (rows === undefined) rows = callRows(calls, sql, params);
            if (rows === undefined) rows = bridgePolicyRows(bridges, policies, sql, params);
            return rows === undefined ? [] : rows;
        }
    };
    if (opts.noTx) return { matches, snapshots, calls, bridges, policies, doQuery: db.doQuery };
    return withSnapshotTx(db, matches, snapshots, calls, bridges, policies);
}

// BTC indexer stub. The two cross-checks resolve the SAME db.js methods at two different
// thresholds, and the stub models them apart:
//   minStake '0'  -> existence check's delegated-key admission (_verifyStakes stage 2): the
//                    delegation-aware effective signer set. Backed by opts.effective,
//                    defaulting to `staked`. A key in `effective` but NOT in `staked` models a
//                    DELEGATED-only signer: authorized by a staked source, no stakes row of its
//                    own. Stage 2 runs only for keys the direct query rejected, so with no
//                    `effective` override the resolver is never reached for existence.
//   anything else -> the completeness check (verifyCompleteness): the qualifying set at
// the threshold recovery reconstructed as of the snapshot block
//                    or null when this handle carries no coin config, in which case db.js
//                    applies its own local floor. Backed by
//                    opts.capSets = { <capability>: [{pubkey, source, weight}] }.
// `staked` backs the direct-stake doQuery probe (stage 1, and the whole answer for a handle
// with no resolver). opts.truncated = [<capability>...] flags a capped resolution. Every
// resolver call is recorded in `calls` as { capability, minStake, method } so a test can pin
// both the threshold and WHICH resolver a check reached for.
//
// opts.localFloor models a handle that DOES carry a coin config: it publishes
// STAKING.CAPABILITIES.<cap>.MIN_STAKE (what recovery reads as the genesis floor) and it makes
// the resolver behave like db.js, filtering capSets by the threshold actually in force
// (caller override when supplied, local floor otherwise) instead of returning every row.
// opts.slashRestores = [{source, restored}] answers the as-of-block capability_slash_debits
// reconstruction: stake burned AFTER the snapshot block, which the archived weight
// must be judged with, not without.
function btcDbStub(staked, opts) {
    opts = opts || {};
    let set = new Set(staked.map(p => p.toLowerCase()));
    let effective = (opts.effective || staked).map(p => String(p).toLowerCase());
    let capSets = opts.capSets || {};
    // The source(s) a key is really bound to on chain; an archived row must claim one of
    // them to pass the key-source binding check. Mirrors the fixture's per-key formula. opts.bindings
    // overrides it per key, and takes an ARRAY for a key backed by more than one source.
    let boundSources = (pk) => {
        let b = (opts.bindings && opts.bindings[pk] !== undefined)
            ? opts.bindings[pk] : ('src_' + String(pk).slice(0, 16));
        return Array.isArray(b) ? b.map(String) : [String(b)];
    };
    let truncated = new Set(opts.truncated || []);
    let calls = [];
    function resolve(capability, minStake, method) {
        calls.push({ capability, minStake, method });
        // db.js: a caller override is honoured VERBATIM, the local floor is only the default.
        let bar = (minStake !== null && minStake !== undefined) ? minStake
                : (opts.localFloor !== undefined ? opts.localFloor : null);
        let out = (minStake === '0')
            ? effective.map(pk => ({ pubkey: pk, source: 'src_' + pk.slice(0, 16), weight: '5' }))
            : (capSets[capability] || [])
                .map(r => ({ pubkey: r.pubkey, source: r.source, weight: String(r.weight != null ? r.weight : r.amount) }))
                .filter(r => bar === null || Number(r.weight) >= Number(bar));
        out.truncated = truncated.has(capability);
        return out;
    }
    let effectiveSet = new Set(effective);
    let db = {
        calls,
        async doQuery(sql, params) {
            if (String(sql).includes('capability_slash_debits'))
                return (opts.slashRestores || []).map(r => ({ source: r.source, restored: String(r.restored) }));
            // The key-source binding check's (pubkey, source) probe, told apart from the delegation-blind
            // existence query by its `ia.address = ?` leg. Answering it on the PUBKEY alone
            // would make this stub incapable of ever saying no, so it matches the pair: the
            // stakes leg answers for a directly-staked key, the delegations leg for a
            // delegated-only one, and both require the claimed source to be the one that
            // key is actually bound to (bindingSource).
            if (/ia\.address\s*=\s*\?/.test(String(sql))) {
                let pk  = String(params[0]).toLowerCase();
                let src = String(params[1]);
                if (!boundSources(pk).includes(src)) return [];
                let leg = /FROM\s+delegations/.test(String(sql)) ? effectiveSet : set;
                return leg.has(pk) ? [{ 1: 1 }] : [];
            }
            return set.has(String(params[0]).toLowerCase()) ? [{ 1: 1 }] : [];
        },
        async getStakeWeightsByCapability(cap, block, minStake) { return resolve(cap, minStake, 'getStakeWeightsByCapability'); },
        async getValidatorsByCapability(cap, block, minStake) { return resolve(cap, minStake, 'getValidatorsByCapability'); }
    };
    if (opts.localFloor !== undefined) {
        let caps = {};
        for (let c of ['cross_chain', 'oracle_publish', 'price', 'attestation'])
            caps[c] = { MIN_STAKE: String(opts.localFloor) };
        db.config = { STAKING: { CAPABILITIES: caps } };
    }
    return db;
}

// Raw-handle stub: doQuery only, no capability resolvers. Models a unit fixture or an
// embedder holding a bare query handle, where _verifyStakes degrades to the legacy
// direct-stake existence query.
function rawStakeHandleStub(staked, opts) {
    opts = opts || {};
    let set = new Set(staked.map(p => p.toLowerCase()));
    let boundSources = (pk) => {
        let b = (opts.bindings && opts.bindings[pk] !== undefined)
            ? opts.bindings[pk] : ('src_' + String(pk).slice(0, 16));
        return Array.isArray(b) ? b.map(String) : [String(b)];
    };
    return { async doQuery(sql, params) {
        let pk = String(params[0]).toLowerCase();
        // The binding check runs on a bare handle too (it needs no resolver), so this stub has to
        // answer the pair probe on the PAIR, not on the pubkey alone.
        if (/ia\.address\s*=\s*\?/.test(String(sql)))
            return (set.has(pk) && boundSources(pk).includes(String(params[1]))) ? [{ 1: 1 }] : [];
        return set.has(pk) ? [{ 1: 1 }] : [];
    } };
}

// Full qualifying set the BTC resolver would report for a set of signing keys,
// matching the fixture's per-key source formula ('src_' + pubkey[:16], weight 5 unless the
// archive under test was built at another weight).
function capSetFromKeys(keys, weight) {
    let w = String(weight != null ? weight : '5');
    return keys.map(k => ({ pubkey: k.pubkey, source: 'src_' + k.pubkey.slice(0, 16), weight: w }));
}

// BTC indexer stub for the reward restore. Recovery STAGES archived rewards by raw
// source-address string into recovery_pending_rewards (assigning NO index id), so the stub
// captures that INSERT. It must NOT call createAddress/getOrCreatePubkeyId at restore time;
// expose them as poisoned to assert the id-assignment path is gone (the apply hook assigns
// ids later, during the reindex, not here).
// opts.failOnRewardIndex: throw when staging the Nth (0-based) reward row, modelling a DB
// error part-way through a batch. opts.noTx: raw handle with no transaction API.
function rewardBtcDbStub(opts) {
    opts = opts || {};
    let rewards = [];
    let saved = null;
    let db = {
        rewards,
        async createAddress() { throw new Error('recovery must not assign index ids at restore time (F1a)'); },
        async getOrCreatePubkeyId() { throw new Error('recovery must not assign pubkey ids at restore time (F1a)'); },
        async doQuery(sql, params) {
            if (sql.includes('INSERT INTO recovery_pending_rewards')) {
                if (opts.failOnRewardIndex === rewards.length) throw new Error('ER_LOCK_DEADLOCK: staging failed');
                rewards.push({ source_address: params[0], validator_pubkey: params[1], reward_type: params[2],
                               round_reference: params[3], amount: params[4], block_index: params[5] });
            }
            return [];
        }
    };
    if (opts.noTx) return db;
    db.commits = 0;
    db.rollbacks = 0;
    db.beginTransaction = async function () { saved = rewards.map(r => Object.assign({}, r)); };
    db.commitTransaction = async function () { db.commits++; saved = null; };
    db.rollbackTransaction = async function () {
        if (saved === null) return;
        db.rollbacks++;
        rewards.length = 0; for (let r of saved) rewards.push(r);
        saved = null;
    };
    return db;
}

module.exports = {
    util, AUTHOR, OUTSIDER, ARMED_DOGE_BLOCK,
    memDb, btcDbStub, rawStakeHandleStub, capSetFromKeys, rewardBtcDbStub,
};
