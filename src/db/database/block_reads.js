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
 * XChain Indexer - Database class part: block reads and memos
 *
 * Per-block reads and memos: the reorg witness helpers, protocol block time, the name and
 * poll-tally caches, block leaf rows, recovery reward application and the caret-ref gate.
 *
 * A part of the Database class body: db/index.js installs it onto Database.prototype,
 * non-enumerable and in the order the class declared it, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// Strict, as the class body these methods came from was.
'use strict';

const crypto  = require('crypto');
const protocolTime = require('../../consensus/protocol_time');
const caretRefStrict = require('./caret_ref_strict_gate');
// The frozen anchor/archive reward heights: the derive flag-day and the fleet-agreed
// mirror-completeness watermark. Recovery-restored rewards claim their ORIGINAL derive
// height from here, so a restored row and a live-derived one carry the same stamp.
const ar = require('../../consensus/gates/anchor_reward_gate.js');

module.exports = {

    // Get EVERY decoder reorg event newer than the one the indexer last processed, oldest
    // first, each as {id, block_index} where block_index is that event's deepest (lowest)
    // orphaned block. A single-newest-event reader would drop the older, deeper reorg when
    // two reorgs land between indexer iterations and the newer one is shallower, leaving
    // orphaned rows below the rollback point.
    // Processing the full set (and rolling back to the minimum block across it) closes that
    // gap. afterId is the decoder event id from getLastProcessedReorgId (null = none yet).
    // Stable hash of a decoder REORG event's `data` payload, used as the reorg-marker witness
    // (#2735). sha256 hex; null/undefined data hashes the empty string so a missing payload has a
    // deterministic witness rather than throwing.
    hashReorgData(data){
        return crypto.createHash('sha256').update(String(data == null ? '' : data), 'utf8').digest('hex');
    },

    // Build the canonical RE-1 (reorg cursor incoherent) error. One shared shape + operator
    // recovery guidance for every incoherence cause (over-cursor, missing cursor row, witness
    // mismatch), so the message never drifts. `detail` names the specific cause.
    reorgCursorIncoherentError(detail){
        return new Error('Reorg cursor incoherent (RE-1): ' + detail + ' The decoder DB was likely ' +
            'rebuilt or restored out-of-band; rollback detection would be silently disabled. ' +
            'Recovery: rebuild decoder+indexer jointly (clean reindex), or restore a matching decoder DB.');
    },

    // Handle getting block time for a given block. Memoized (last-block-wins, see
    // this._blockTimeCache in the constructor): block_time is constant per block_index, and
    // protocol_changes.isEnabled() calls this repeatedly per block under the hot per-action path.
    // PROTOCOL time for a block: what every time-keyed consensus reader should use.
    //
    // On networks switched to median-time-past (see protocol_time.js) this is the
    // median of the previous 11 block timestamps rather than the block's own stamp.
    // The raw stamp is chosen by whoever mined the block and Bitcoin accepts it up
    // to ~2h ahead of network-adjusted time; on testnet4 that is not hypothetical,
    // the chain rides its 20-minute minimum-difficulty rule and stamps every block
    // ~1201s ahead of its parent. Reading mirrored hub data at a future instant is
    // what forced the mirror barriers to wait for wall clock to catch up, which is
    // what made a confirmed transaction take hours to index.
    //
    // Applied HERE rather than at each call site on purpose: this is the single
    // seam every protocol reader already flows through (actions.js, protocol
    // changes, the six mirror barriers), so they all move together. A reader left
    // on the raw stamp while the barriers move is the combination that forks.
    // Storage and display must NOT use this - createBlock and the chain-tip push
    // take getRawBlockTime, so the timestamp we persist and show stays the real one.
    async getBlockTime(block_index){
        let key = Number(block_index);
        // Lazily created: this method is also reached through hand-built Database
        // doubles that predate the memo, and an absent cache must degrade to "always
        // recompute" rather than throwing on the consensus path.
        if(!this._protocolTimeCache)
            this._protocolTimeCache = { block_index: null, block_time: null };
        if(this._protocolTimeCache.block_index === key)
            return this._protocolTimeCache.block_time;
        let raw = await this.getRawBlockTime(block_index);
        let network = (this.config) ? this.config['NETWORK'] : undefined;
        let protocolTimeValue = raw;
        if(protocolTime.isProtocolTimeMtpActive(network) && raw !== false){
            let previous = await this.getPreviousBlockTimes(key, protocolTime.MEDIAN_TIME_SPAN);
            protocolTimeValue = protocolTime.protocolTime(network, raw, previous);
        }
        // Never memoize an unresolvable lookup, for the same reason the raw reader
        // does not: the retry must re-query against a healthy DB.
        if(raw !== false){
            this._protocolTimeCache.block_index = key;
            this._protocolTimeCache.block_time  = protocolTimeValue;
        }
        return protocolTimeValue;
    },

    // Invalidate the single-entry getBlockTime() memo. A reorg replaces the content of an
    // already-processed height: the decoder re-inserts the new-chain block with a new
    // block_time, and the indexer's blocks row for that height is deleted by rollback. The
    // memo is keyed by height ONLY, so on a depth-1 reorg the replay of the same height would
    // otherwise return the orphaned chain's stale block_time (a cache hit), feeding the wrong
    // timestamp into time-gated consensus logic (ProtocolChanges.isEnabled, fee-price gate,
    // createBlock). Rollback calls this on BOTH DB instances after commit so the replay
    // re-reads the new chain's block_time. Mirrors the decoder's per-height reorg clear.
    clearBlockTimeCache(){
        this._blockTimeCache    = { block_index: null, block_time: null };
        // The protocol-time memo is derived from the raw one AND from the 11 blocks
        // below it, so a reorg invalidates it for the same reason and then some: the
        // replayed height can shift the median even when its own stamp is unchanged.
        this._protocolTimeCache = { block_index: null, block_time: null };
    },

    // Invalidate the light-client touched-key resolver memos (_smtTickNameCache /
    // _smtAddressNameCache), which map a dense surrogate id to its canonical name.
    //
    // THE MEMOS ARE ONLY VALID FOR AS LONG AS THE ID ASSIGNMENTS THEY SAW SURVIVE.
    // A dense id is handed out as MAX(id)+1 (getNextTickerId / getNextAddressId), so
    // anything that REMOVES the row hands the same id straight back to the next
    // caller. A reorg is one way (rollback.js deletes rows and commits, and clears
    // these there). A TRANSACTION ROLLBACK is the other, and it was missed for three
    // investigations: the ids an aborted transaction assigned are un-assigned by the
    // abort, while the id -> name memo it filled survives in process memory.
    //
    // The rolled-back writer that matters is not the block loop, it is the READ-ONLY
    // dry run behind /feequote and /preflight (actions.js computeDryRun): it runs the
    // real handler inside a transaction it ALWAYS rolls back, so an ISSUE that is
    // merely quoted still interns its tick, still reaches createLedgerChangeRecord,
    // and still fills this memo with id -> the quoted name. Nothing is ever
    // broadcast, the id is freed, and the next real ISSUE/MINT/SEND takes that id -
    // at which point the choke point records the touched key under the QUOTED name.
    // The ledger names the real one, the commitment applies the quoted one, and the
    // touched-set guard refuses the block. That is a HARD WEDGE: the block retries
    // forever, because the poisoned entry lives in memory that no retry clears, which
    // is why a process restart (and only a process restart) fixed it every time.
    //
    // Called from rollbackTransaction() and from commitTransaction()'s failure
    // rollback, i.e. wherever assigned ids are un-assigned. Clearing is cheap (pure
    // memoisation, refilled lazily on the next block's first touch of each id);
    // invalidating per id would mean enumerating rows the abort has already erased.
    clearSmtNameCaches(){
        this._smtTickNameCache    = null;
        this._smtAddressNameCache = null;
    },

    // True when the poll's cached fingerprint equals `fingerprint` (no input changed since the
    // last tally, so the full re-tally can be skipped). Missing entry (first sight this process,
    // or just-cleared by a reorg) never matches, forcing a full tally.
    pollTallyWatermarkMatches(pollIndex, fingerprint){
        return this._pollTallyWatermark.get(Number(pollIndex)) === fingerprint;
    },

    // Record the fingerprint at which the poll was last tallied WITHOUT early-deciding.
    setPollTallyWatermark(pollIndex, fingerprint){
        this._pollTallyWatermark.set(Number(pollIndex), fingerprint);
    },

    // Drop a single poll's watermark (called once it finalizes so a reused action_index can never
    // rehydrate a stale hit).
    clearPollTallyWatermarkEntry(pollIndex){
        this._pollTallyWatermark.delete(Number(pollIndex));
    },

    // Drop ALL cached poll watermarks. Called from rollback.js after a reorg commits, alongside
    // clearBlockTimeCache: a reorg can delete and re-add ledger/vote/delegation rows at or above
    // the reorg block (and reuse action_index values), so every cached fingerprint is suspect.
    clearPollTallyWatermark(){
        this._pollTallyWatermark = new Map();
    },

    // Return the canonical per-block leaf rows (ledger/actions/contracts) in the
    // EXACT order getBlockHashes hashes them, for the light-client block_merkle_root
    // (SPV spec §5.1). Reuses the warm getBlockHashes stash; recomputes only if the
    // stash is cold/stale (e.g. a standalone proof-rebuild path).
    async getBlockLeafRows(block_index){
        if(!this._lastGatheredBlockRows || Number(this._lastGatheredBlockRows.block_index) !== Number(block_index))
            await this.getBlockHashes(block_index);
        return this._lastGatheredBlockRows;
    },

    // F1a recovery reward apply hook. Called from createAddress right after an address
    // first receives its deterministic in-block id. Cheap-gates on a one-time-probed count
    // of unapplied staged rewards so normal indexing (no recovery in progress) pays a single
    // COUNT(*) and then short-circuits on every later call. See the constructor flags above
    // and recovery.js for the staging side.
    async maybeApplyPendingRewards(address, source_id, materializedBlock){
        if(source_id === null || source_id === undefined)
            return;
        if(!await this.probeRecoveryPending())
            return;
        // Stamp applied_block = the block this address was first seen at (createAddress
        // passes its block context). It is the forward-window key xchain-sync streams
        // these by; without it a materialization whose earn-block sits below a follower's
        // incremental cursor never reaches the follower (the reorg re-drain is the acute
        // case, but a recovery-then-incremental-catch-up has the same gap).
        let applied = await this.applyPendingRewardsForAddress(address, source_id, materializedBlock);
        this._recoveryPendingRemaining -= applied;
    },

    // The block a recovery-restored reward claims as its MATERIALIZATION block, from the
    // earn-block the ANCHOR archive carries. Thin wrapper so both the apply path and the
    // due sweep read the one rule (anchor_reward_activation.restoredRewardDeriveHeight):
    // the restored row claims the height the LIVE fleet derived it at
    // (earn + ANCHOR_REWARD_MIRROR_MATURITY), never the height recovery re-applied it at.
    // null below the derive flag-day / on an inert network, where the legacy NULL stamp stands.
    restoredRewardDeriveBlock(earnBlock){
        let network = String((this.config && this.config['NETWORK']) || '');
        return ar.restoredRewardDeriveHeight(earnBlock, network);
    },

    // Whether the strict `^<id>` rejection is in effect at `block_index` on
    // this indexer's chain. Wrapper so handlers gate on the same predicate
    // resolveAddressRefChecked uses without re-deriving network/coin.
    // @param {block_index}  integer  block being processed
    isCaretRefStrictActive(block_index){
        return caretRefStrict.isCaretRefStrictActive(block_index, this.config['NETWORK'], this.config['COIN']);
    },

    // Resolve a wire ^<id> address reference AND state the activation-gated verdict
    // on it. THE call action handlers should use: resolveAddressRef alone reports a
    // malformed/dangling reference only by leaving the value untouched, which is safe
    // solely while every caller remembers to format-check the field afterwards (see
    // db/database/caret_ref_strict_gate.js for the three call sites where that does not
    // hold, and for what the same omission cost on SEND).
    //
    // Returns { value, rejected }:
    //   value    - the resolved address, or the input unchanged when resolution failed.
    //              IDENTICAL in both eras: the verdict never rides inside the value,
    //              because handlers persist their cloned `data` row even for invalid
    //              actions and a sentinel would silently rewrite the stored bytes.
    //   rejected - true only at/after the flag-day AND when the value is still a
    //              caret reference (resolution failed). Below the flag-day, or with no
    //              block context, always false: legacy fail-open, replay byte-identical.
    // @param {value}        string   wire field value (may be a full address, a ^<id>, or null)
    // @param {block_index}  integer  block being processed (data['BLOCK_INDEX'])
    async resolveAddressRefChecked(value, block_index){
        let resolved = await this.resolveAddressRef(value);
        let rejected = caretRefStrict.isUnresolvedCaretRef(resolved)
            && this.isCaretRefStrictActive(block_index);
        return { value: resolved, rejected: rejected };
    },

};
