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
 *
 * XChain Indexer - Hub DB Sync Client: retractions
 *
 * Applying a reorg retraction to the mirror: the receive-side fences, the
 * signed-retraction gate, and the per-table deletes, plus the Ed25519
 * verification of a quorum-class co-signature set.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const crypto = require('crypto');
const { getLogger } = require('../../observability/index.js');
const swq    = require('../../stake_weighted_quorum.js');
const { isRetractionSigningActive } = require('../../retraction_signing_activation.js');
const { RETRACTION_COLUMNS, RETRACTION_CHAIN_COLUMNS } = require('./mirror_tables.js');
const { applyMirrorWrite } = require('./mirror_write.js');

// ── signed-retraction verification helpers ───────────────────────────

// Rebuild the retraction canonical from the wire event. MUST byte-match the
// producer in xchain-hub/src/consensus/retraction.js canonicalRetraction():
//   XRETRACTV1|<table>|<source_chain>|<from>|<to or ''>|<generation or ''>|<snapshot_block>
function canonicalRetraction(event) {
    let to  = (event.to_action_index       !== undefined && event.to_action_index       !== null) ? String(event.to_action_index)       : '';
    let gen = (event.retraction_generation !== undefined && event.retraction_generation !== null) ? String(event.retraction_generation) : '';
    return 'XRETRACTV1|' + String(event.table) + '|' + String(event.source_chain) + '|' +
           String(event.from_action_index) + '|' + to + '|' + gen + '|' + String(event.snapshot_block);
}

// Ed25519 verify with Node's built-in crypto (raw 32-byte hex pubkey, 64-byte
// hex signature over the utf8 canonical). Kept dependency-free: this module is
// vendored byte-identical into xchain-explorer, which must not grow requires.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function verifyEd25519(payload, sigHex, pubkeyHex) {
    if (!/^[0-9a-f]{64}$/.test(pubkeyHex) || !/^[0-9a-f]{128}$/.test(sigHex)) return false;
    try {
        let key = crypto.createPublicKey({
            key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pubkeyHex, 'hex')]),
            format: 'der', type: 'spki'
        });
        return crypto.verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(sigHex, 'hex'));
    } catch (e) {
        return false;
    }
}

// The action-index range and generation fence one deletion event names. `bounded` is
// the CLOSED range of a deferred retraction (to_action_index present); `fenced` is the
// item-5308 push_generation fence. Null when from_action_index is not a number.
function parseRetractionRange(event) {
    let from = Number(event.from_action_index);
    if (!Number.isFinite(from)) return null;
    let to = (event.to_action_index !== undefined && event.to_action_index !== null)
             ? Number(event.to_action_index) : null;
    let bounded = (to !== null && Number.isFinite(to));
    let gen = (event.retraction_generation !== undefined && event.retraction_generation !== null)
              ? Number(event.retraction_generation) : null;
    let fenced = (gen !== null && Number.isFinite(gen) && gen >= 0);
    return { from: from, to: to, bounded: bounded, gen: gen, fenced: fenced };
}

module.exports = {

    // Apply a reorg retraction to the local hub DB copy. The hub deletes price
    // rows seeded from rolled-back PRICE actions; we mirror that delete so this
    // indexer stops reading prices that were never finalized on-chain.
    // event: { table, source_chain, from_action_index, to_action_index?, retraction_generation? }
    // When the broadcaster supplies to_action_index the hub applied a CLOSED-range delete
    // (a deferred retraction, item 5296); we MUST mirror the same bound or the replica diverges
    // from the hub by deleting re-published rows the hub kept. Absent (live retraction) =>
    // open-ended `>= from`, exactly as before.
    // retraction_generation (item 5308): when present, the hub fenced its delete to rows with
    // push_generation <= it; we mirror the SAME fence so a row re-published at a recycled
    // action_index (higher generation) survives on the replica too (ordering-independent
    // convergence: a late delete is a no-op against the higher-generation re-published row).
    // Absent (older hub) => no fence, prior behavior. For cross_chain_matches the fence is
    // per-leg (a_push_generation / b_push_generation), matching the hub's per-leg retraction.
    async applyRetraction(event) {
        let range = parseRetractionRange(event);
        if (range === null) return;                        // malformed, skip
        // Receive-side guards (see the constructor note for why they exist).
        // 1. Quorum-class tables (their insertions carry 2f+1 proof) never accept an
        //    unfenced open delete: every current source stamps the item-5308 fence, so
        //    an unfenced event is either a pre-5308 relic or a fabricated wipe. The
        //    same applies to ANY table's retraction claiming a reorg of OUR OWN chain
        //    when we can check (our own retractions are always fenced).
        // bridge_transfers joins the quorum class: its rows are federation-co-signed and a
        // deletion mints value out of existence on the destination chain the same way a
        // forged match would, so an unfenced or unsigned deletion must be refused rather
        // than applied. policy_snapshots is absent because it is never retracted at all
        // (no RETRACTION_COLUMNS entry, so the generic path below skips it).
        let quorumClass = (event.table === 'cross_chain_calls' || event.table === 'cross_chain_matches' ||
                           event.table === 'bridge_transfers');
        let ownChain = !!(this.coin && event.source_chain === this.coin && this.getOwnRollbackGeneration);
        if (!(await this.acceptRetractionFences(event, range, quorumClass, ownChain))) return;
        if (quorumClass && this.network && !(await this.acceptRetractionSignatures(event, range))) return;
        if (event.table === 'cross_chain_matches') return await this.retractMatchLegs(event, range);
        if (event.table === 'cross_chain_calls')   return await this.retractCalls(event, range);
        await this.retractByColumn(event, range);
    },

    // Guards 1 to 3: the unfenced-delete refusal, the own-chain generation check and the
    // per-(table, source_chain) monotonicity fence. False refuses the event.
    async acceptRetractionFences(event, range, quorumClass, ownChain) {
        if ((quorumClass || ownChain) && !range.fenced) {
            getLogger().error('HubDbSync: refusing UNFENCED retraction of ' + event.table +
                ' (source_chain ' + event.source_chain + ', from ' + range.from +
                '): quorum-class deletions require a retraction_generation fence');
            return false;
        }
        if (range.fenced) {
            // 2. Our own chain: only a rollback WE performed can legitimately retract
            //    rows sourced from this chain, and it always carries a pre-bump
            //    generation. Refuse anything at/above our current generation. Fail
            //    closed on a read error: for our own chain this delete is only the
            //    idempotent backstop behind rollback.js's local pre-delete.
            if (ownChain) {
                let own = null;
                try { own = Number(await this.getOwnRollbackGeneration()); } catch (e) { own = null; }
                if (own === null || !Number.isFinite(own) || range.gen >= own) {
                    getLogger().error('HubDbSync: refusing retraction of ' + event.table + ' for OWN chain ' +
                        this.coin + ' at generation ' + range.gen + ' (own rollback generation ' + own +
                        '): no local rollback produced this fence');
                    return false;
                }
            }
            // 3. Monotonicity: a fence below the last one observed for this
            //    (table, source_chain) is a stale replay; skip it. Equal = redelivery,
            //    idempotent under the fence, still applied.
            let trackKey = event.table + '|' + event.source_chain;
            let tracked = this.trackedRollbackGeneration[trackKey];
            if (tracked !== undefined && range.gen < tracked) {
                getLogger().warn('HubDbSync: skipping stale retraction of ' + event.table +
                    ' (source_chain ' + event.source_chain + ') at generation ' + range.gen +
                    ' < last-observed rollback generation ' + tracked);
                return false;
            }
            this.trackedRollbackGeneration[trackKey] = range.gen;
        }
        return true;
    },

    // 4. Signed retractions (full fix): once this mirror's own
    //    capability_snapshots high-water mark has crossed the
    //    RETRACTION_SIGNING flag-day era, a quorum-class deletion must carry
    //    a 2f+1 `cross_chain` co-signature set over the XRETRACTV1 canonical,
    //    verified against the mirrored snapshot at the event's snapshot_block
    //    (streamed ahead of the deletion on the same ordered socket). The gate
    //    is judged from LOCAL state so an attacker cannot slip below it by
    //    omitting or understating wire fields. Pre-bootstrap (no snapshot rows
    //    at all) or with no network wired there is no signer set to verify
    //    against and the fences above stand alone (legacy tier).
    async acceptRetractionSignatures(event, range) {
        let gateBlock = null;
        try {
            let rows = await this.hubDb.doQuery(
                "SELECT MAX(snapshot_block) AS sb FROM capability_snapshots WHERE capability = 'cross_chain'");
            if (rows.length > 0 && rows[0].sb !== null) gateBlock = Number(rows[0].sb);
        } catch (e) { gateBlock = null; }                  // mirror table not ready yet
        if (gateBlock !== null && isRetractionSigningActive(gateBlock, this.network)) {
            let ok = await this.verifyRetractionSignatures(event);
            if (!ok) {
                getLogger().error('HubDbSync: refusing UNVERIFIED retraction of ' + event.table +
                    ' (source_chain ' + event.source_chain + ', from ' + range.from +
                    '): quorum-class deletions require a valid 2f+1 co-signature set');
                return false;
            }
        }
        return true;
    },

    // cross_chain_matches is two-sided: a match is retracted when EITHER order leg on
    // the reorged chain was rolled back. The settlement pass then rolls back any leg it
    // already applied for that match (its cross_chain_settlements row drops with the block).
    async retractMatchLegs(event, range) {
        let leg = (col, gcol) => '(' + col + '_chain = ? AND ' + col + '_action_index >= ?' +
            (range.bounded ? ' AND ' + col + '_action_index <= ?' : '') +
            (range.fenced ? ' AND ' + gcol + ' <= ?' : '') + ')';
        let legArgs = () => {
            let p = [event.source_chain, range.from];
            if (range.bounded) p.push(range.to);
            if (range.fenced) p.push(range.gen);
            return p;
        };
        await applyMirrorWrite(this.hubDb, 
            'DELETE FROM cross_chain_matches WHERE ' + leg('a', 'a_push_generation') + ' OR ' + leg('b', 'b_push_generation'),
            legArgs().concat(legArgs()));
        await this.refreshMatchSyncTimestamp();
    },

    // cross_chain_calls retracts on its source-chain request (the XCALL v0 row
    // that was reorged away). Both phases drop: a dispatch whose request
    // vanished must never produce an execution or a callback here.
    async retractCalls(event, range) {
        let tail = 'source_chain = ? AND source_action_index >= ?' +
            (range.bounded ? ' AND source_action_index <= ?' : '') +
            (range.fenced ? ' AND push_generation <= ?' : '');
        let args = [event.source_chain, range.from];
        if (range.bounded) args.push(range.to);
        if (range.fenced) args.push(range.gen);
        await applyMirrorWrite(this.hubDb, 'DELETE FROM cross_chain_calls WHERE ' + tail, args);
        await this.refreshCallSyncTimestamp();
    },

    // Every other retractable table: one DELETE over its RETRACTION_COLUMNS range, keyed
    // on its own source-chain column (RETRACTION_CHAIN_COLUMNS, `source_chain` by default).
    async retractByColumn(event, range) {
        let column = RETRACTION_COLUMNS[event.table];
        if (!column) return;                                   // unknown table, skip
        let chainColumn = RETRACTION_CHAIN_COLUMNS[event.table] || 'source_chain';
        let query = 'DELETE FROM ' + event.table + ' WHERE ' + chainColumn + ' = ? AND ' + column + ' >= ?' +
            (range.bounded ? ' AND ' + column + ' <= ?' : '') +
            (range.fenced ? ' AND push_generation <= ?' : '');
        let args = [event.source_chain, range.from];
        if (range.bounded) args.push(range.to);
        if (range.fenced) args.push(range.gen);
        await applyMirrorWrite(this.hubDb, query, args);
        // bridge_transfers gates a block-loop barrier on a cached MAX(effective_time), so a
        // retraction that removed the row holding the maximum has to re-read it here; a
        // scalar left high would open the bridge barrier over transfers that are gone.
        // The two tables above this line refresh inside their own branches for the same
        // reason, and neither remaining generic table (oracle_prices, price_snapshots) is
        // reached by a deletion without its own refresh at the caller.
        if (event.table === 'bridge_transfers') await this.refreshBridgeSyncTimestamp();
    },

    // Verify a quorum-class retraction's co-signature set. The event
    // must carry snapshot_block (itself at/after the flag-day era, so a signed
    // set can never be minted below the gate) plus retraction_signatures; each
    // signature is checked over the rebuilt XRETRACTV1 canonical against the
    // mirrored `cross_chain` capability snapshot at that block, with the same
    // quorum predicate the settlement pass applies to match insertions
    // (stake-weighted at/above SWQ activation, else count 2f+1/majority).
    async verifyRetractionSignatures(event) {
        let sb = Number(event.snapshot_block);
        if (!Number.isFinite(sb) || sb < 0) return false;
        if (!isRetractionSigningActive(sb, this.network)) return false;
        let sigs = event.retraction_signatures;
        if (!Array.isArray(sigs) || sigs.length === 0) return false;

        let rows;
        try {
            rows = await this.hubDb.doQuery(
                "SELECT signing_pubkey, amount, source FROM capability_snapshots WHERE capability = 'cross_chain' AND snapshot_block = ?", [sb]);
        } catch (e) { return false; }
        if (!rows || rows.length === 0) return false;          // no snapshot at that block -> nothing to verify against

        let validators = rows.map(r => ({
            pubkey: String(r.signing_pubkey).toLowerCase(),
            source: String(r.source != null ? r.source : ''),
            weight: String(r.amount != null ? r.amount : '0')
        }));
        let snapPubkeys = new Set(validators.map(v => v.pubkey));

        let canonical = canonicalRetraction(event);
        let validSigners = [], seen = new Set();
        for (let s of sigs) {
            let pk  = String(s && s.pubkey || '').toLowerCase();
            let sig = String(s && s.sig || '').toLowerCase();
            if (!pk || seen.has(pk)) continue;
            if (!snapPubkeys.has(pk)) continue;
            if (!verifyEd25519(canonical, sig, pk)) continue;
            // Mark seen only AFTER the signature verifies, matching
            // the hub producer twin (RetractionConsensus.handleFinalized) and the
            // sibling tallies in actions/anchor/index.js / recovery.js / StateAnchorPublisher. Marking
            // on first encounter lets a garbage-then-valid pair for one snapshot member
            // consume the dedupe slot and suppress the real signature, under-counting the
            // quorum and refusing a retraction the hub itself finalized.
            seen.add(pk);
            validSigners.push(pk);
        }
        let weighted = swq.isStakeWeightedQuorumActive(sb, this.network);
        let n = validators.length;
        return weighted
            ? swq.meetsStakeThreshold(validators, validSigners)
            : (validSigners.length >= ((n <= 1) ? 1 : Math.max(2 * Math.floor((n - 1) / 3) + 1, Math.ceil((n + 1) / 2))));
    },

};
