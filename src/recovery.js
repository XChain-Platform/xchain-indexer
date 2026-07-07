#!/usr/bin/env node
'use strict';

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
 * Full-parse recovery CLI to rebuild the cross-chain match mirror from the
 * on-chain ANCHOR archive, with NO surviving hub database.
 *
 * Reads the DOGE indexer's anchor_actions (populated purely by chain parse),
 * reassembles each archive batch (v1 + v2 continuation chunks), and for every
 * batch that passes verification rebuilds cross_chain_matches and
 * capability_snapshots so a from-genesis reindex of BTC/LTC/DOGE re-derives
 * cross-chain settlements identically.
 *
 * Verification per batch (all self-contained in the archive):
 *   1. CRC32 of the decompressed JSON must equal the v1's signed BATCH_CRC32.
 *   2. The v1 wrapper signatures must reach 2f+1 of the ARCHIVED
 *      oracle_publish set at the anchor's snapshot_block.
 *   3. Every match's validator_signatures must reach 2f+1 of the ARCHIVED
 *      cross_chain set at the match's snapshot_block.
 *   4. (--verify-stakes, recommended) every archived snapshot pubkey must
 *      hold ANY active on-chain stake at its snapshot_block in the given BTC
 *      indexer DB. A fabricated validator set cannot survive this, because
 *      staking is on-chain. The chain stays the root of trust.
 *
 * Later batches supersede earlier ones per match_id (latest-status-wins), so
 * a match archived as `finalized` and later re-archived as `retracted` ends
 * recovered as retracted.
 *
 *   node src/recovery.js [--dry-run] [--verify-stakes]
 *
 * Reads INDEXER_DB_* from the service environment (.env). Point it at the
 * DOGE indexer DB. --verify-stakes additionally needs BTC_INDEXER_DB_NAME
 * (same host/credentials) holding the BTC indexer's stakes tables.
 *
 ********************************************************************/

const zlib    = require('zlib');
const crypto  = require('crypto');
const ed25519 = require('./ed25519.js');
const swq     = require('./stake_weighted_quorum.js');
const eq      = require('./equivocation_header.js');
const ccr     = require('./cross_chain_royalty_activation.js');

class AnchorRecovery {

    // db: doQuery handle on the DOGE indexer DB (anchor_actions + the mirror
    // tables to rebuild). opts.btcDb: optional doQuery handle on the BTC
    // indexer DB for the stake cross-check. opts.dryRun: verify + report only.
    constructor(db, opts){
        opts = opts || {};
        this.db     = db;
        this.btcDb  = opts.btcDb || null;
        this.dryRun = !!opts.dryRun;
        // Explicit flag, NOT btcDb presence: the reward restore runs BEFORE the
        // BTC reindex (empty stakes table), where the stake cross-check would
        // wrongly fail every batch. Run a --verify-stakes --dry-run pass AFTER
        // the reindex for the cross-check.
        this.verifyStakes = !!opts.verifyStakes;
        // mathjs bignumber helpers (same instance the indexer uses) for the
        // stake-weighted quorum predicate. Required when replaying archives whose
        // snapshot_block is at/above STAKE_WEIGHTED_QUORUM.
        this.util   = opts.util || null;
        this.log    = opts.log || ((msg) => console.log(msg));
    }

    async run(){
        let report = { batches: 0, verified: 0, failed: [], matches: 0, snapshots: 0, calls: 0, rewards: 0 };

        let v1s = await this.db.doQuery(
            "SELECT * FROM anchor_actions WHERE version = 1 ORDER BY match_batch_seq ASC");
        if(!v1s || v1s.length === 0){
            this.log('recovery: no archive anchors found (anchor_actions has no v1 rows)');
            return report;
        }

        for(let v1 of v1s){
            report.batches++;
            let batchSeq = Number(v1.match_batch_seq);
            try {
                let archive = await this._verifyBatch(v1);
                if(!this.dryRun) await this._rebuild(archive, report);
                else {
                    report.matches   += archive.matches.length;
                    report.calls     += (archive.calls || []).length;
                    report.snapshots += (archive.capability_snapshots || []).length;
                    report.rewards   += (archive.rewards || []).length;
                }
                report.verified++;
                this.log('recovery: batch ' + batchSeq + ' OK (' + archive.matches.length + ' matches, ' +
                         ((archive.calls || []).length) + ' calls, ' + ((archive.rewards || []).length) + ' rewards)');
            } catch(e){
                report.failed.push({ batch_seq: batchSeq, reason: e.message });
                this.log('recovery: batch ' + batchSeq + ' FAILED: ' + e.message);
            }
        }

        this.log('recovery: ' + report.verified + '/' + report.batches + ' batches verified, ' +
                 report.matches + ' match rows, ' + report.calls + ' call rows, ' +
                 report.snapshots + ' snapshot rows, ' + report.rewards + ' reward rows' +
                 (this.dryRun ? ' (dry run, nothing written)' : ''));
        return report;
    }

    // ── Per-batch verification ──────────────────────────────────────────────────

    async _verifyBatch(v1){
        // Reassemble v1 chunk 0 + v2 continuations.
        let totalChunks = Number(v1.total_chunks) || 1;
        let b64 = String(v1.archive_b64 || '');
        if(totalChunks > 1){
            let chunks = await this.db.doQuery(
                "SELECT chunk_index, archive_b64 FROM anchor_actions WHERE version = 2 AND match_batch_seq = ? ORDER BY chunk_index ASC",
                [Number(v1.match_batch_seq)]);
            if(!chunks || chunks.length !== totalChunks - 1)
                throw new Error('incomplete batch: ' + ((chunks || []).length) + '/' + (totalChunks - 1) + ' continuation chunks');
            for(let c of chunks) b64 += c.archive_b64;
        }

        // CRC binds the blob to the signed structure.
        // Bound decompressed output (gzip-bomb DoS guard); zlib throws RangeError past
        // the cap, which the catch rejects as an invalid archive.
        let json;
        try { json = zlib.gunzipSync(Buffer.from(b64, 'base64url'), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8'); }
        catch(e){ throw new Error('archive is not valid gzip'); }
        if(this._crc32Hex(json) !== String(v1.batch_crc32))
            throw new Error('BATCH_CRC32 mismatch');

        let archive = JSON.parse(json);
        if(!archive || !Array.isArray(archive.matches))
            throw new Error('malformed archive JSON');
        if(archive.matches.length !== Number(v1.match_count))
            throw new Error('MATCH_COUNT mismatch (' + archive.matches.length + ' != ' + v1.match_count + ')');

        let snaps = Array.isArray(archive.capability_snapshots) ? archive.capability_snapshots : [];
        // Source-keyed rows {pubkey, source, weight} so the weighted predicate can
        // dedupe by staking source; the legacy count path uses only .pubkey.
        let setFor = (capability, block) => snaps
            .filter(s => s.capability === capability && Number(s.snapshot_block) === Number(block))
            .map(s => ({ pubkey: String(s.signing_pubkey).toLowerCase(), source: String(s.source != null ? s.source : ''), weight: String(s.amount != null ? s.amount : '0') }));

        // Optional but recommended: archived validator sets must be backed by
        // real on-chain BTC stakes. Fabricated sets cannot survive this.
        if(this.verifyStakes && this.btcDb) await this._verifyStakes(snaps);

        // 1. Wrapper signatures vs the ARCHIVED oracle_publish set.
        let wrapperSet = setFor('oracle_publish', v1.snapshot_block);
        let wrapperCanonical = this._wrapperCanonical(v1);
        let wrapperSigs = this._parseSigs(v1.validator_signatures);
        if(!this._quorumVerified(wrapperCanonical, wrapperSigs, wrapperSet, swq.isStakeWeightedQuorumActive(v1.snapshot_block, v1.network)))
            throw new Error('wrapper signatures fail quorum against the archived oracle_publish set');

        // 2. Every match's signatures vs the ARCHIVED cross_chain set.
        for(let m of archive.matches){
            let set  = setFor('cross_chain', m.snapshot_block);
            let sigs = this._parseSigs(m.validator_signatures);
            if(!this._quorumVerified(this._matchCanonical(m), sigs, set, swq.isStakeWeightedQuorumActive(m.snapshot_block, m.network)))
                throw new Error('match ' + String(m.match_id).substring(0, 16) + '... fails quorum against the archived cross_chain set');
        }

        // 3. Every XCALL relay row's signatures vs the ARCHIVED cross_chain set.
        // `calls` is absent from pre-XCALL archives; treated as empty.
        for(let c of (archive.calls || [])){
            let set  = setFor('cross_chain', c.snapshot_block);
            let sigs = this._parseSigs(c.validator_signatures);
            if(!this._quorumVerified(this._callCanonical(c), sigs, set, swq.isStakeWeightedQuorumActive(c.snapshot_block, c.network)))
                throw new Error('call ' + String(c.call_id).substring(0, 16) + '... (' + c.phase + ') fails quorum against the archived cross_chain set');
        }

        // 4. Shape-check archived anchor-publish rewards (absent pre-rewards
        // archives, treated as empty). Reward rows carry no per-row signatures; they are
        // bound by the wrapper CRC+quorum, and the archiving followers re-derived
        // each one from deterministic election state before co-signing. ONLY
        // anchor publish rewards are restorable. oracle_round and attest_fee are
        // re-derived from the chain parse itself, so an archive that claims them
        // is malformed (or malicious) and the batch is rejected.
        for(let r of (archive.rewards || [])){
            if(!/^[0-9a-fA-F]{64}$/.test(String(r.validator_pubkey || '')))
                throw new Error('reward row has malformed validator_pubkey');
            if(!r.source || typeof r.source !== 'string')
                throw new Error('reward row is missing its earn-time source');
            if(!/^anchor_[A-Za-z_]+$/.test(String(r.reward_type || '')))
                throw new Error('reward row has non-anchor reward_type "' + r.reward_type + '"; only anchor publish rewards are archivable');
            if(!Number.isFinite(Number(r.round_number)) || Number(r.round_number) < 0)
                throw new Error('reward row has malformed round_number');
            if(!/^[0-9]+(\.[0-9]+)?$/.test(String(r.amount || '')) || !(Number(r.amount) > 0))
                throw new Error('reward row has malformed amount');
            if(!Number.isFinite(Number(r.block_index)) || Number(r.block_index) < 0)
                throw new Error('reward row has malformed block_index');
        }

        return archive;
    }

    // Every archived snapshot pubkey must hold ANY active stake at its block.
    async _verifyStakes(snaps){
        for(let s of snaps){
            let rows = await this.btcDb.doQuery(
                `SELECT 1 FROM stakes st
                 JOIN index_pubkeys ip ON ip.id = st.signing_pubkey_id
                 JOIN index_statuses ix ON ix.id = st.status_id
                 WHERE ip.pubkey = ? AND ix.status = 'valid'
                   AND st.activation_block <= ?
                   AND (st.deactivation_block IS NULL OR st.deactivation_block > ?)
                 LIMIT 1`,
                [String(s.signing_pubkey).toLowerCase(), Number(s.snapshot_block), Number(s.snapshot_block)]);
            if(!rows || rows.length === 0)
                throw new Error('archived snapshot pubkey ' + String(s.signing_pubkey).substring(0, 16) +
                                '... has no on-chain stake at block ' + s.snapshot_block + ' (fabricated set?)');
        }
    }

    // ── Rebuild (latest-status-wins: batches process in batch_seq order) ───────

    async _rebuild(archive, report){
        for(let s of (archive.capability_snapshots || [])){
            await this.db.doQuery(
                'INSERT IGNORE INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?)',
                [Number(s.snapshot_block), String(s.capability), String(s.signing_pubkey).toLowerCase(), String(s.amount), String(s.source || '')]);
            report.snapshots++;
        }
        for(let m of archive.matches){
            let existing = await this.db.doQuery(
                'SELECT match_id FROM cross_chain_matches WHERE match_id = ? LIMIT 1', [m.match_id]);
            if(existing && existing.length > 0){
                // Same immutable terms; only the status can move (finalized to retracted).
                await this.db.doQuery(
                    'UPDATE cross_chain_matches SET status = ? WHERE match_id = ?', [m.status, m.match_id]);
            } else {
                // Rebuild under the ORIGINAL hub-assigned id as provenance only.
                // Settlement order is (snapshot_block, match_id), so replay does
                // not depend on this value; keeping it preserves archive
                // byte-parity. Archives published before the field was added carry
                // no id; those rows fall back to AUTO_INCREMENT.
                let hasId = Number.isFinite(Number(m.id)) && Number(m.id) > 0;
                let idCol  = hasId ? 'id, ' : '';
                let idMark = hasId ? '?, ' : '';
                let idVal  = hasId ? [Number(m.id)] : [];
                // finalizing_view rides the archive (MATCH_KEYS) and feeds the EQUIV
                // signing canonical (_matchCanonical) exactly as for calls below.
                // Dropping it lands view>0 matches at view 0 and forks re-verification.
                // a_payout_legs/b_payout_legs ride the archive (MATCH_KEYS, omit-when-null)
                // at/above the CROSS_CHAIN_ROYALTY flag-day; they feed the signing canonical
                // (_matchCanonical), so dropping them would fork re-verification exactly like
                // dropping finalizing_view. Pre-royalty archives carry no key → null.
                await this.db.doQuery(
                    `INSERT INTO cross_chain_matches
                        (${idCol}match_id, snapshot_block, network,
                         a_chain, a_action_index, a_kind, a_tick, a_amount, a_filled_before, a_ownership, a_payout_addr, a_payout_legs,
                         b_chain, b_action_index, b_kind, b_tick, b_amount, b_filled_before, b_ownership, b_payout_addr, b_payout_legs,
                         effective_time, validator_signatures, status, finalizing_view)
                     VALUES (${idMark}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [...idVal, m.match_id, Number(m.snapshot_block), m.network,
                     m.a_chain, Number(m.a_action_index), m.a_kind, m.a_tick, m.a_amount, m.a_filled_before, Number(m.a_ownership), m.a_payout_addr, (m.a_payout_legs != null ? String(m.a_payout_legs) : null),
                     m.b_chain, Number(m.b_action_index), m.b_kind, m.b_tick, m.b_amount, m.b_filled_before, Number(m.b_ownership), m.b_payout_addr, (m.b_payout_legs != null ? String(m.b_payout_legs) : null),
                     Number(m.effective_time), m.validator_signatures, m.status, Number(m.finalizing_view) || 0]);
            }
            report.matches++;
        }
        // Anchor-publish rewards restore into the BTC indexer DB. They must be
        // present BEFORE the BTC reindex replays its first COLLECT, or
        // historically valid claims re-validate as 'no unclaimed rewards' and
        // the recovered ledger diverges. Runbook ordering: DOGE archive extract,
        // then BTC reward restore (this), then BTC reindex.
        let rewards = archive.rewards || [];
        if(rewards.length > 0){
            if(!this.btcDb)
                throw new Error('archive carries ' + rewards.length + ' reward rows but no BTC indexer DB handle was provided (set BTC_INDEXER_DB_NAME); restoring without them would corrupt COLLECT replay');
            // F1a id-determinism fix: do NOT assign index ids at restore time. The old path
            // called createAddress/getOrCreatePubkeyId here, OUTSIDE a block tx, which seeded
            // low AUTO_INCREMENT ids that offset every subsequent in-block deterministic id
            // (getNextAddressId is MAX(id)+1 over ALL rows). A recovered node then built a
            // different index_addresses map than a from-genesis node, forking ^id resolution
            // and breaking validator_rewards parity across the recovery boundary.
            //
            // Instead stage each archived reward keyed by the RAW source-address string + the
            // signing pubkey, assigning no id. The earn-time source is still pinned by the
            // archive (no restore-time drift if the pubkey was later re-staked elsewhere).
            // During the BTC reindex, when the source address first receives its deterministic
            // in-block id, db.createAddress's apply hook materializes the staged rewards into
            // validator_rewards under that deterministic source_id. The source's STAKE precedes
            // its COLLECT in chain order, so the id (and therefore the reward) exists before the
            // COLLECT replays, preserving the "rewards present before the reindex's first COLLECT"
            // ordering invariant without ever perturbing the counter. recovery_pending_rewards is
            // recovery-local: not consensus-hashed, not replicated by xchain-sync.
            for(let r of rewards){
                await this.btcDb.doQuery(
                    `INSERT INTO recovery_pending_rewards
                        (source_address, validator_pubkey, reward_type, round_reference, amount, block_index)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [String(r.source).substring(0, 120), String(r.validator_pubkey).toLowerCase().substring(0, 64),
                     String(r.reward_type), Number(r.round_number), String(r.amount), Number(r.block_index)]);
                report.rewards++;
            }
        }

        for(let c of (archive.calls || [])){
            let existing = await this.db.doQuery(
                'SELECT call_id FROM cross_chain_calls WHERE call_id = ? AND phase = ? LIMIT 1', [c.call_id, c.phase]);
            if(existing && existing.length > 0){
                // Same immutable terms; only the lifecycle status can move
                // (finalized to retracted).
                await this.db.doQuery(
                    'UPDATE cross_chain_calls SET status = ? WHERE call_id = ? AND phase = ?',
                    [c.status, c.call_id, c.phase]);
            } else {
                // Rebuild under the ORIGINAL hub-assigned id as provenance only.
                // Injection order is (snapshot_block, call_id), so replay does not
                // depend on this value; keeping it preserves archive byte-parity.
                // finalizing_view is signed into the EQUIV canonical (WI-2 bump 2):
                // the indexer rebuilds the XCALL signing canonical from this column
                // to re-verify the hub's 2f+1 sigs. Omitting it lets the NOT NULL
                // DEFAULT 0 land every recovered row at view 0, so any call finalized
                // at view>0 (a leader failover) fails re-verification on the recovered
                // node. This strands undelivered calls and forks re-derivation. It rides
                // the archive (CALL_KEYS) and the verifier already trusts it.
                await this.db.doQuery(
                    `INSERT INTO cross_chain_calls
                        (id, call_id, phase, snapshot_block, network,
                         source_chain, source_action_index, source_contract_index,
                         target_chain, target_contract_index, method, params_json,
                         gas_limit, cross_hops, effective_time, status, result_status,
                         return_payload_b64, validator_signatures, finalizing_view)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [Number(c.id), c.call_id, c.phase, Number(c.snapshot_block), c.network,
                     c.source_chain, Number(c.source_action_index), Number(c.source_contract_index),
                     c.target_chain, Number(c.target_contract_index), c.method, c.params_json,
                     Number(c.gas_limit), Number(c.cross_hops), Number(c.effective_time), c.status,
                     c.result_status, c.return_payload_b64, c.validator_signatures, Number(c.finalizing_view) || 0]);
            }
            report.calls++;
        }
    }

    // ── Canonicals (byte-identical to their producers) ──────────────────────────

    // Hub StateCheckpointEngine canonical + the v1 archive extension (anchor.js).
    // v1 ROUND_ID appends batch_seq (distinct from the v0 per-block key, the R-4 fix);
    // gated on the BTC snapshot_block + network, VIEW=0. Must byte-match anchor._canonical.
    _wrapperCanonical(v1){
        let raw = ['XCHECKPOINT', v1.chain, v1.network, String(v1.block_index), v1.block_hash,
                v1.ledger_hash, v1.actions_hash, v1.contract_hash,
                String(v1.checkpoint_seq), String(v1.snapshot_block),
                String(v1.match_batch_seq), String(v1.match_count), v1.batch_crc32,
                String(v1.total_chunks)].join('|');
        if(eq.isEquivHeaderActive(v1.snapshot_block, v1.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
                v1.chain + '|' + v1.network + '|' + v1.block_index + '|' + v1.checkpoint_seq + '|' + v1.match_batch_seq, 0, raw);
        return raw;
    }

    // Hub CrossChainDexEngine._canonicalMatch / indexer cross_settle._canonical.
    _matchCanonical(m){
        let raw = [
            'XMATCH', m.match_id, String(m.snapshot_block),
            m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr,
            m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr,
            String(m.effective_time), m.network || '',
            m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'),
            m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')
        ].join('|');
        // Cross-chain royalty legs ride the signed match at/above the CROSS_CHAIN_ROYALTY
        // flag-day; below it the canonical is byte-identical to the legacy format.
        if(ccr.isCrossChainRoyaltyActive(m.snapshot_block, m.network))
            raw += '|' + String(m.a_payout_legs || '') + '|' + String(m.b_payout_legs || '');
        // EQUIV (WI-2 bump 2): VIEW = the archived row's finalizing_view (serialized into
        // the archive by StateAnchorPublisher.MATCH_KEYS). TAG=XDEX, ROUND_ID=match_id.
        if(eq.isEquivHeaderActive(m.snapshot_block, m.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, m.match_id, (m.finalizing_view != null ? m.finalizing_view : 0), raw);
        return raw;
    }

    // Hub CrossChainCallEngine._canonicalMatch / indexer verifiers (xexec.js
    // dispatch, xcall.js result).
    _callCanonical(c){
        let sha = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex');
        let phase = (c.phase === 'result') ? 'result' : 'dispatch';
        let raw;
        if(c.phase === 'result'){
            raw = [
                'XCALL', 'RESULT', c.call_id, String(c.snapshot_block), c.network || '',
                c.target_chain, String(c.result_status || ''),
                sha(c.return_payload_b64), String(c.effective_time)
            ].join('|');
        } else {
            raw = [
                'XCALL', 'DISPATCH', c.call_id, String(c.snapshot_block), c.network || '',
                c.source_chain, String(c.source_action_index), String(c.source_contract_index),
                c.target_chain, String(c.target_contract_index),
                c.method, sha(c.params_json),
                String(c.gas_limit), String(c.cross_hops), String(c.effective_time)
            ].join('|');
        }
        // EQUIV (WI-2 bump 2): TAG=XCALL, ROUND_ID = sha256('XCALLROUND|'+phase+'|'+call_id),
        // VIEW = the archived row's finalizing_view. Byte-matches hub + xexec/xcall twins.
        if(eq.isEquivHeaderActive(c.snapshot_block, c.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, sha('XCALLROUND|' + phase + '|' + c.call_id), (c.finalizing_view != null ? c.finalizing_view : 0), raw);
        return raw;
    }

    _parseSigs(raw){
        try {
            let sigs = (typeof raw === 'string') ? JSON.parse(raw || '[]') : raw;
            return Array.isArray(sigs) ? sigs.filter(s => s && s.pubkey && s.sig) : [];
        } catch(e){ return []; }
    }

    // validatorSet: [{pubkey, source, weight}] from the archived snapshot. When
    // `weighted` (snapshot_block at/above STAKE_WEIGHTED_QUORUM), the bar is summed
    // signer STAKE > 2/3 of S (source-deduped); else the legacy 2f+1 signer count.
    _quorumVerified(canonical, sigs, validatorSet, weighted){
        let qualified = new Set((validatorSet || []).map(v => String(v.pubkey).toLowerCase()));
        if(qualified.size === 0) return false;
        let validSigners = [], seen = new Set();
        for(let s of sigs){
            let pk = String(s.pubkey).toLowerCase();
            if(seen.has(pk) || !qualified.has(pk)) continue;
            seen.add(pk);
            if(ed25519.verify(canonical, String(s.sig), pk)) validSigners.push(pk);
        }
        if(weighted)
            return swq.meetsStakeThreshold(validatorSet, validSigners);
        let quorum = (qualified.size <= 1) ? 1 : Math.max(2 * Math.floor((qualified.size - 1) / 3) + 1, Math.ceil((qualified.size + 1) / 2));
        return validSigners.length >= quorum;
    }

    _crc32Hex(str){
        let n = zlib.crc32 ? zlib.crc32(Buffer.from(str, 'utf8')) : this._crc32Fallback(Buffer.from(str, 'utf8'));
        return (n >>> 0).toString(16).padStart(8, '0');
    }
    _crc32Fallback(buf){
        let c, crc = 0xFFFFFFFF;
        for(let i = 0; i < buf.length; i++){
            c = (crc ^ buf[i]) & 0xFF;
            for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            crc = (crc >>> 8) ^ c;
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
}

module.exports = AnchorRecovery;

// ── CLI ─────────────────────────────────────────────────────────────────────
if(require.main === module){
    const dotenv = require('dotenv');
    dotenv.config();
    const Database = require('./db.js');
    const config   = require('./config.js');
    const Utility  = require('./utility.js');

    (async () => {
        const host = process.env.INDEXER_DB_HOST;
        const port = process.env.INDEXER_DB_PORT;
        const name = process.env.INDEXER_DB_NAME;
        const user = process.env.INDEXER_DB_USER;
        const pass = process.env.INDEXER_DB_PASS;
        if(!host || !name || !user){
            console.error('recovery: INDEXER_DB_HOST / INDEXER_DB_NAME / INDEXER_DB_USER must be set (point at the DOGE indexer DB).');
            process.exit(2);
        }
        const dryRun       = process.argv.includes('--dry-run');
        const verifyStakes = process.argv.includes('--verify-stakes');

        // Share ONE config object between indexer-like and its Utility.
        const cfg = config.getConfig();
        const indexerLike = { config: cfg, util: new Utility(cfg) };
        const db = new Database(host, port, name, user, pass, indexerLike);

        // The BTC indexer DB handle serves two roles: the --verify-stakes
        // cross-check AND the anchor-publish reward restore (rewards live in the
        // BTC DB so COLLECT replay can find them). Archives that carry reward
        // rows hard-require it.
        let btcDb = null;
        const btcName = process.env.BTC_INDEXER_DB_NAME;
        if(btcName){
            btcDb = new Database(host, port, btcName, user, pass, indexerLike);
        } else if(verifyStakes){
            console.error('recovery: --verify-stakes needs BTC_INDEXER_DB_NAME (same host/credentials).');
            process.exit(2);
        } else {
            console.warn('recovery: BTC_INDEXER_DB_NAME not set. Archived validator sets will not be cross-checked, and any batch carrying anchor reward rows will FAIL (the restore needs the BTC indexer DB).');
        }
        if(!verifyStakes)
            console.warn('recovery: running WITHOUT --verify-stakes. Archived validator sets will not be cross-checked against on-chain BTC stakes.');

        try {
            const recovery = new AnchorRecovery(db, { btcDb, dryRun, verifyStakes, util: indexerLike.util });
            const report = await recovery.run();
            process.exitCode = (report.failed.length > 0) ? 1 : 0;
        } catch(err){
            console.error('recovery: FAILED: ' + ((err && err.stack) || err));
            process.exitCode = 1;
        } finally {
            process.exit();
        }
    })();
}
