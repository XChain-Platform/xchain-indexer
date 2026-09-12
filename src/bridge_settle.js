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
 * XChain Platform - bridge settle pass (system-injected, mirror-driven)
 *
 * BUILT. The seam's module shape, function names, parameter sets, return shapes and the D2
 * hook are unchanged; the bodies are here. verifyEscrowAgainstCheckpoint is the one door into
 * bridge_checkpoint_check.js, whose proof this pass fetches through bridge_proof_client.js
 * before calling it. The pass driver processBridgeSettlePass is what XChainIndexer.js calls.
 *
 * WHAT THIS FILE IS. The hub federation signs a transfer record (bridge_transfers) or a
 * token policy snapshot (policy_snapshots) and delivers it through the hub-DB mirror.
 * This module applies THIS chain's leg of an effective row: it verifies the quorum
 * locally, injects the XBRIDGE v2/v5 settle action (or the XPOLICY leg set), and records
 * the application in bridge_settlements for idempotency and rollback. There is NO on-chain
 * transaction for a settle leg; it is an internal action, like CROSS_SETTLE and SWAP_MATCH.
 *
 * WHY IT IS A SEPARATE FILE FROM actions/xbridge.js. The same split cross_settle.js has
 * from the handlers whose escrow it releases: the wire handler is driven by a transaction
 * mined on this chain, the settle pass by an end-of-block sweep over mirrored rows. Keeping
 * them apart is also what lets the wire lane and the settle lane build in parallel.
 *
 * HOW IT IS DRIVEN. XChainIndexer.js's ordered pass list calls this immediately AFTER
 * util.processCrossChainSettlements and BEFORE util.processCrossChainCalls. THE POSITION IS
 * PINNED AND IS NOT A STYLE CHOICE: it assigns action indexes, so it is consensus-visible,
 * and it is what makes a credit bound at block B spendable at B+1 on every node and never
 * at B. That call site is made, in that position, and it passes this module's own ctx.
 *
 * ORDER, CAP AND BARRIER. Finalized rows apply in (snapshot_block, transfer_id) order at
 * the first block whose protocol block_time is at or past effective_time, at most
 * XBRIDGE_MAX_PER_BLOCK = 25 per destination chain per block, overflow carrying forward in
 * order and never dropped. Policy snapshots run at the HEAD of the pass, at most
 * XPOLICY_MAX_PER_BLOCK = 5 per block per chain, in (snapshot_block, snapshot_id) order
 * across ticks and by policy_seq within one tick. The pass runs behind waitForBridgeSync
 * (and waitForPolicySync), which run behind waitForSnapshotSync, so the capability rows the
 * quorum is verified against are already present.
 *
 * TRUST, STATED PLAINLY. In milestone 1 a compromised hub supplies BOTH the record and the
 * roster that verifies it: off the origin chain the validator set itself is resolved from
 * the mirrored capability_snapshots. That is why verifyEscrowAgainstCheckpoint exists and
 * why nothing arms on mainnet before it is built.
 *
 * RETRACTION. A mirror deletion for a row that has not been applied means it is never
 * applied. A row already applied STAYS applied: the destination chain did not reorg, so
 * there is nothing there to roll back, and a forward un-mint would change that chain's
 * hashes forward rather than back. The invariant read reports the deficit and the watch
 * raises CRIT.
 *
 * Spec: the base bridge spec sections 6 to 9 and row 17 (D2);
 * the token bridge spec section 5; the token bridge policy spec
 * sections 4 to 6.
 *
 ********************************************************************/

'use strict';

const crypto      = require('crypto');
const ed25519     = require('./ed25519.js');
const swq         = require('./stake_weighted_quorum.js');
const eq          = require('./equivocation_header.js');
const cpCheck     = require('./bridge_checkpoint_check.js');
const proofClient = require('./bridge_proof_client.js');
const Genesis     = require('./genesis.js');
const { XBRIDGE_MAX_PER_BLOCK, XPOLICY_MAX_PER_BLOCK } = require('./protocol/constants.js');

// Why a row did not apply. LOG reasons, never consensus verdict strings: an injected settle
// leg writes no STATUS (actions/xbridge.js returns a system-injected v2/v5 untouched, so the
// settle pass is the only writer of that row) and no canonical carries any of these. The
// boolean beside them is the consensus-visible part.
const SETTLE_REASON = {
    NOT_OURS:        'this chain is not the destination leg of the transfer',
    ROW_FIELDS:      'transfer row is missing fields the apply needs',
    NETWORK:         'row network does not match this indexer',
    CHAIN_ID:        'row btc_chain_id does not match this chain identity',
    NOT_FINALIZED:   'row is not finalized',
    NOT_DUE:         'effective_time is ahead of this block protocol time',
    ALREADY_APPLIED: 'already recorded in bridge_settlements',
    QUORUM:          'insufficient cross_chain quorum over the signed canonical',
    SNAPSHOT_ABSENT: 'capability snapshot for snapshot_block is not mirrored yet',
    ESCROW_PROOF:    'escrow cross-check refused the row',
    ESCROW_MISSING:  'no escrow role address is configured for the source chain',
    ESCROW_SHORT:    'escrow balance would go negative',
    TOKEN_ROW:       'the bridged token row could not be created',
    AMOUNT:          'amount is not a positive decimal at the signed decimals',
    // Policy-only
    POLICY_HASH:     'recomputed policy_hash does not match the signed hash',
    POLICY_ORDER:    'membership array is not in canonical order',
    POLICY_ORIGIN:   'this chain is the origin of the policy, nothing to inherit',
    POLICY_NO_COPY:  'no bridged copy of the tick exists on this chain yet',
    POLICY_SEQ_GAP:  'an earlier policy_seq for this tick is finalized and not applied yet',
    POLICY_LEG:      'an injected policy leg did not apply',
};

// The injected policy legs, ordinal per leg. CONSENSUS-VISIBLE and pinned by the policy spec
// section 4: the ordinal is the synthetic transaction's vout, so it decides the action index
// each leg takes, and a reordering here would give two nodes different action indexes for the
// same snapshot. Legs with nothing to do are not injected, which is why the ordinal is fixed
// per LEG rather than assigned by counting the legs that ran.
const POLICY_LEG_ORDINAL = {
    ALLOW_CREATE_OR_REMOVE: 0,
    ALLOW_ADD:              1,
    BLOCK_CREATE_OR_REMOVE: 2,
    BLOCK_ADD:              3,
    ISSUE_POINT:            4,
    SLEEP:                  5,
};

// LIST wire constants (actions/list.js): type 2 is an ADDRESS list, edit 1 is ADD and 2 is
// REMOVE. Named here so the injected wire strings read as the protocol rather than as magic.
const LIST_TYPE_ADDRESS = '2';
const LIST_EDIT_ADD     = '1';
const LIST_EDIT_REMOVE  = '2';

// Synthetic transaction hash prefixes. They separate the injected families so one pass's hash
// can never collide with another's: 'GENESIS-' is genesis.js's, 'XPOLICY-' is the policy
// spec's (D11) and 'XBRIDGE-' is this pass's token-row creation. The policy prefix plus 48
// characters of the snapshot id is 56 characters, inside the 64-character unique prefix of
// index_transactions.hash.
const POLICY_TX_PREFIX = 'XPOLICY-';
const BRIDGE_TX_PREFIX = 'XBRIDGE-';

function _isNull(v){ return v === null || v === undefined || v === ''; }

// A finite non-negative integer, or null. Heights, ordinals and action indexes arrive from a
// MariaDB driver that may hand back a number, a string or a BigInt depending on its bigint
// options, so the conversion is pinned here rather than trusted from the call site.
function _int(v){
    if(v === null || v === undefined) return null;
    if(typeof v === 'bigint') return (v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(v) : null;
    const n = Number(v);
    return (Number.isFinite(n) && Number.isInteger(n) && n >= 0) ? n : null;
}

function _sha256(s){ return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

/**
 * The signed content canonical of a transfer record, wrapped by the equivocation header.
 * MUST byte-match the hub's CrossChainBridgeEngine. Every field is String()-coerced and a
 * null is an empty string, the platform's canonical rule.
 *
 * @param {Object} row - a bridge_transfers row
 * @returns {string}
 */
function transferCanonical(row){
    const raw = [
        'XBRIDGE', row.transfer_id, String(row.snapshot_block),
        row.tick || '', String(row.decimals),
        row.src_chain || '', String(row.src_action_index), row.src_address || '',
        row.dest_chain || '', row.dest_address || '',
        String(row.amount), String(row.effective_time), row.network || ''
    ].join('|');
    if(eq.isEquivHeaderActive(row.snapshot_block, row.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.BRIDGE, row.transfer_id,
                                      (row.finalizing_view != null ? row.finalizing_view : 0), raw);
    return raw;
}

/**
 * The signed content canonical of a policy snapshot, wrapped by the equivocation header.
 * MUST byte-match the hub. `sleeping` is deliberately ABSENT: it is committed through
 * policy_hash alone (policy spec D17), so repeating it here would be a second, divergent
 * commitment of the same fact.
 *
 * @param {Object} row - a policy_snapshots row
 * @returns {string}
 */
function policyCanonical(row){
    const raw = [
        'XPOLICY', row.snapshot_id, String(row.snapshot_block),
        row.origin_chain || '', row.tick || '', String(row.policy_seq),
        String(row.origin_block), row.policy_hash || '',
        String(row.effective_time), row.network || ''
    ].join('|');
    if(eq.isEquivHeaderActive(row.snapshot_block, row.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.POLICY, row.snapshot_id,
                                      (row.finalizing_view != null ? row.finalizing_view : 0), raw);
    return raw;
}

/**
 * Recompute policy_hash from the TRANSPORT membership arrays, exactly as the hub built it:
 *
 *   ALLOW|<n or ->|<addr>|...|BLOCK|<m or ->|<addr>|...|SLEEP|<0 or 1>
 *
 * `-` means the origin row has no such list at all; `0` means it has an EMPTY one, and the
 * two are not the same thing (policy spec D7: an empty allow list is deny-everyone under
 * isActionAllowed, while an absent one is no gate at all).
 *
 * THE ARRAYS ARE HASHED AS GIVEN, never re-sorted. Sorting first would make an out-of-order
 * transport array hash to the signed value, which is precisely the property that lets
 * verifyMembershipOrder below be a real guard instead of decoration.
 *
 * @param {Array<string>|null} allow
 * @param {Array<string>|null} block
 * @param {boolean} sleeping
 * @returns {string} lowercase sha256 hex
 */
function policyHash(allow, block, sleeping){
    const part = (label, list) => {
        if(list === null || list === undefined) return [label, '-'];
        return [label, String(list.length)].concat(list.map(String));
    };
    const text = part('ALLOW', allow)
        .concat(part('BLOCK', block))
        .concat(['SLEEP', sleeping ? '1' : '0'])
        .join('|');
    return _sha256(text);
}

/**
 * True when a membership array is already in the canonical order the hub built the hash over:
 * `utf8_bin`, i.e. plain byte order, the order db.getList returns for a type-2 address list.
 *
 * Byte order and NOT JavaScript's default string comparison: the default compares UTF-16 code
 * units, which orders a supplementary-plane character before a BMP character above U+E000 and
 * would accept an array the hub would have ordered the other way. Addresses are ASCII today,
 * so the two agree today; the guard is written against the rule rather than against today's
 * data, because the day they disagree is the day a legitimate snapshot is refused fleet-wide.
 *
 * @param {Array<string>|null} list
 * @returns {boolean} true for null and for a list of fewer than two items
 */
function verifyMembershipOrder(list){
    if(list === null || list === undefined) return true;
    if(!Array.isArray(list)) return false;
    for(let i = 1; i < list.length; i++){
        const prev = Buffer.from(String(list[i - 1]), 'utf8');
        const cur  = Buffer.from(String(list[i]),     'utf8');
        if(Buffer.compare(prev, cur) > 0) return false;
    }
    return true;
}

/**
 * Parse a transport membership column: a JSON array, or null when the origin row holds no such
 * list. A malformed value is NOT read as an empty list, because empty and absent mean opposite
 * things under isActionAllowed; it returns the `bad` sentinel so the caller refuses the row.
 *
 * @param {*} value
 * @returns {Array<string>|null|false} false means malformed
 */
function parseMembership(value){
    if(value === null || value === undefined) return null;
    if(Array.isArray(value)) return value.map(String);
    let parsed;
    try { parsed = JSON.parse(String(value)); } catch(e){ return false; }
    if(parsed === null) return null;
    if(!Array.isArray(parsed)) return false;
    return parsed.map(String);
}

/**
 * The CROSS_SETTLE quorum rule, verbatim (cross_settle.js:144-195), over an already-built
 * canonical. Shared by the transfer and the policy apply so the two can never drift.
 *
 * A signature counts only if its pubkey is in the `cross_chain` set at snapshot_block AND
 * verifies, and a pubkey enters the seen-set only AFTER its signature verifies: marking on
 * first encounter lets a garbage-then-valid pair for one qualified validator suppress the real
 * signature, which fails a quorate row CLOSED. Stake-weighted source-deduped two-thirds at or
 * above STAKE_WEIGHTED_QUORUM_ACTIVATION, else 2f+1.
 *
 * @param {string} canonical
 * @param {*} signaturesJson - the row's validator_signatures column
 * @param {number} snapshotBlock
 * @param {string} network
 * @param {Object} indexerDb
 * @returns {Promise<{met: boolean, snapshotAbsent: boolean, valid: number, total: number}>}
 *          snapshotAbsent true means the capability rows are not mirrored yet, which is a
 *          RETRY and never a refusal
 */
async function verifyQuorum(canonical, signaturesJson, snapshotBlock, network, indexerDb){
    const weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, network);
    const validators = weighted
        ? await indexerDb.getStakeWeightsByCapability('cross_chain', snapshotBlock)
        : await indexerDb.getValidatorsByCapability('cross_chain', snapshotBlock);
    const N = (validators && validators.length) ? validators.length : 0;
    if(N === 0) return { met: false, snapshotAbsent: true, valid: 0, total: 0 };

    let sigs;
    try { sigs = JSON.parse(signaturesJson || '[]'); } catch(_){ sigs = []; }
    if(!Array.isArray(sigs)) sigs = [];

    const snapPubkeys = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
    const validSigners = [], seen = new Set();
    for(const s of sigs){
        const pk  = String((s && s.pubkey) || '').toLowerCase();
        const sig = String((s && s.sig) || '').toLowerCase();
        if(seen.has(pk)) continue;
        if(!/^[0-9a-f]{64}$/.test(pk) || !/^[0-9a-f]{128}$/.test(sig)) continue;
        if(!snapPubkeys.has(pk)) continue;
        if(!ed25519.verify(canonical, sig, pk)) continue;
        seen.add(pk);
        validSigners.push(pk);
    }
    const met = weighted
        ? swq.meetsStakeThreshold(validators, validSigners)
        : (validSigners.length >= ((N <= 1) ? 1 : Math.max(2 * Math.floor((N - 1) / 3) + 1, Math.ceil((N + 1) / 2))));
    return { met: met, snapshotAbsent: false, valid: validSigners.length, total: N };
}

/**
 * Has this chain already applied (id, kind)? The read is of the LOCAL bridge_settlements
 * table and never of the mirror, and that is the whole reason the table exists: a mirrored
 * row can be deleted later by a retraction, so "did this chain already apply it?" cannot be a
 * question the mirror answers. `kind` is inside the unique key, so a transfer id and a
 * snapshot id may collide in the id column without colliding as settlements.
 *
 * @param {Object} indexerDb
 * @param {string} id
 * @param {string} kind - 'transfer' or 'policy'
 * @returns {Promise<boolean>}
 */
async function isSettled(indexerDb, id, kind){
    const rows = await indexerDb.doQuery(
        'SELECT transfer_id FROM bridge_settlements WHERE transfer_id = ? AND kind = ? LIMIT 1',
        [String(id), String(kind)]);
    return rows.length > 0;
}

/**
 * Record the applied leg. INSERT IGNORE on (transfer_id, kind), the recordCrossChainSettlement
 * shape: the action_index is rollback-able, so a reorg below the applying block drops this row
 * and the transfer re-applies at a fresh index.
 */
async function recordSettlement(indexerDb, actionIndex, id, kind, blockIndex, row){
    await indexerDb.doQuery(
        `INSERT IGNORE INTO bridge_settlements
         (action_index, transfer_id, kind, block_index, src_chain, src_action_index, dest_chain, dest_address, tick)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [actionIndex, String(id), String(kind), blockIndex,
         row.src_chain || null,
         (row.src_action_index === null || row.src_action_index === undefined) ? null : Number(row.src_action_index),
         row.dest_chain || null, row.dest_address || null, row.tick || null]);
}

// One log line per refusal or deferral, naming the id and the reason, which is the single line
// both specs ask for. Deliberately not an exception: a refused row is ordinary operation.
function _log(kind, id, message){
    console.log('\t ' + kind + ' : ' + String(id).substring(0, 16) + '... : ' + message);
}
function _warn(kind, id, message){
    console.warn('\t ' + kind + ' : ' + String(id).substring(0, 16) + '... : ' + message);
}

/**
 * Apply this chain's leg of one finalized bridge transfer: XBRIDGE v2 (XCHAIN) and v5
 * (a general token). The direction is DERIVED from the row, never read from a column.
 *
 * IN leg (this chain is dest_chain, from a v0/v3 lock on the origin):
 *   credit(row.dest_address, tick, row.amount) at row.decimals
 *   token SUPPLY += row.amount
 *   creating the token row if this chain holds none yet - for XCHAIN the byte-identical
 *   _injectGasToken parameter set through genesis.injectProtocolToken, for a general token
 *   the <ORIGIN> root row and then the <ORIGIN>.<NAME> child row.
 *
 * OUT leg (this chain is the origin, from a v1/v4 burn on the other side):
 *   debit(ADDRESS.BRIDGE_<row.src_chain>, tick, row.amount)
 *   credit(row.dest_address, tick, row.amount)
 *   An escrow balance that would go NEGATIVE is a protocol violation: apply nothing and log
 *   exactly one line naming the transfer_id.
 *
 * Injected legs pay no fee (the CROSS_SETTLE and XEXEC precedent) and bypass isActionAllowed
 * (so a sleeping origin still releases escrow to a burner).
 *
 * VERIFICATION, before any effect, is the CROSS_SETTLE rule verbatim: rebuild the
 * EQUIV-wrapped content canonical
 *   XBRIDGE|transfer_id|snapshot_block|tick|decimals|src_chain|src_action_index|src_address|dest_chain|dest_address|amount|effective_time|network
 * with ENGINE_TAGS.BRIDGE, ROUND_ID = transfer_id, VIEW = row.finalizing_view; a signature
 * counts only if its pubkey is in the cross_chain set at snapshot_block AND verifies, and a
 * pubkey enters the seen-set only AFTER its signature verifies; stake-weighted
 * source-deduped two-thirds at or above STAKE_WEIGHTED_QUORUM_ACTIVATION, else 2f+1. A
 * foreign `network` or a foreign `btc_chain_id` is refused outright.
 *
 * IDEMPOTENCY. A row whose (transfer_id, kind='transfer') is already in bridge_settlements
 * is skipped. The record is local and reorg-rollback-able on purpose: the mirrored row can
 * be deleted later, so "did this chain already apply it?" can never be a read of the mirror.
 *
 * NOT BUILT (lane L14).
 *
 * @param {Object} row - one finalized bridge_transfers row as mirrored: transfer_id,
 *                       snapshot_block, network, src_chain, src_action_index, src_address,
 *                       dest_chain, dest_address, tick, decimals, amount, effective_time,
 *                       finalizing_view, validator_signatures, status, push_generation,
 *                       btc_chain_id
 * @param {Object} ctx - pass context: { actions, indexerDb, util, config, coin, network,
 *                       blockIndex, blockTime }. `blockTime` is the block loop's PROTOCOL
 *                       time (median-time-past off mainnet, the raw stamp on mainnet) and
 *                       is what effective_time is compared against, never a wall clock
 * @returns {Promise<{applied: boolean, reason: (string|null), actionIndex: (number|null)}>}
 *          applied false with a reason for a refusal (terminal) or a not-yet-due row
 *          (carried forward); the reason is what the single log line names
 */
async function applyBridgeTransfer(row, ctx){
    const out = (applied, reason, actionIndex) => ({ applied: applied, reason: reason, actionIndex: actionIndex || null });

    if(!row || typeof row !== 'object' || !ctx || typeof ctx !== 'object')
        return out(false, SETTLE_REASON.ROW_FIELDS);

    const db   = ctx.indexerDb;
    const util = ctx.util;
    const id   = String(row.transfer_id || '');

    const srcChain  = String(row.src_chain || '');
    const destChain = String(row.dest_chain || '');
    const tick      = String(row.tick || '');
    const decimals  = _int(row.decimals);
    const snapshot  = _int(row.snapshot_block);
    if(!id || !srcChain || !destChain || !tick || decimals === null || snapshot === null ||
       _isNull(row.dest_address) || _isNull(row.amount))
        return out(false, SETTLE_REASON.ROW_FIELDS);

    // Network scope, the CROSS_SETTLE belt-and-suspenders guard: the network is inside the
    // signed canonical, so a foreign-network row can never verify here anyway, but refusing it
    // before the signature work keeps a regtest-signed row from ever touching a mainnet ledger
    // read even if a mirror served it.
    if(String(row.network || '') !== String(ctx.network || ''))
        return out(false, SETTLE_REASON.NETWORK);

    // Chain identity, the relic spec's guard: `network` separates environments, `btc_chain_id`
    // separates RE-GENESES of one environment, which is the case a regtest rail actually hits.
    // Transport and not signed, so it is compared only when this node knows its own identity.
    const localChainId = ctx.config ? ctx.config['BTC_CHAIN_ID'] : null;
    if(!_isNull(row.btc_chain_id) && !_isNull(localChainId) &&
       String(row.btc_chain_id) !== String(localChainId))
        return out(false, SETTLE_REASON.CHAIN_ID);

    if(String(row.status || '') !== 'finalized')
        return out(false, SETTLE_REASON.NOT_FINALIZED);

    // The destination leg is always THIS chain's leg: an in leg mints here from a lock on the
    // origin, an out leg releases escrow here from a burn on the other side. Direction is
    // DERIVED from the row and is never a column (D19).
    if(destChain !== String(ctx.coin || ''))
        return out(false, SETTLE_REASON.NOT_OURS);

    // Due, against the block loop's PROTOCOL time (median-time-past off mainnet), never a wall
    // clock: a wall clock differs per node and would apply the same row at different blocks.
    const blockTime = Number(ctx.blockTime);
    if(!Number.isFinite(blockTime) || Number(row.effective_time) > blockTime)
        return out(false, SETTLE_REASON.NOT_DUE);

    if(await isSettled(db, id, 'transfer'))
        return out(false, SETTLE_REASON.ALREADY_APPLIED);

    // The amount moves as the SIGNED TEXT, not as a re-formatted number. `decimals` is a
    // signed field precisely so the string's precision is fixed by the record, and re-rendering
    // it here (bcadd returns a bignumber, whose String() drops trailing zeros) would put a
    // different literal in the ledger than the one the federation signed. So it is VALIDATED
    // against the signed decimals and then passed through untouched, the way every handler
    // passes a wire amount through.
    const amount = String(row.amount);
    if(!util.isValidAmountFormat(decimals, amount, ctx.blockTime) || !util.bcgt(amount, 0))
        return out(false, SETTLE_REASON.AMOUNT);

    // Quorum FIRST, before any effect and before the cross-check. An absent capability snapshot
    // is a retry and not a refusal: the block loop's snapshot barrier front-stops it, and this
    // branch is the residual-race guard.
    const quorum = await verifyQuorum(transferCanonical(row), row.validator_signatures,
                                      snapshot, row.network, db);
    if(quorum.snapshotAbsent){
        _log('XBRIDGE', id, SETTLE_REASON.SNAPSHOT_ABSENT + ' : deferring');
        return out(false, SETTLE_REASON.SNAPSHOT_ABSENT);
    }
    if(!quorum.met){
        _warn('XBRIDGE', id, SETTLE_REASON.QUORUM + ' (' + quorum.valid + '/' + quorum.total + ') : skipping');
        return out(false, SETTLE_REASON.QUORUM);
    }

    // THE D2 HOOK, called UNCONDITIONALLY and AFTER quorum verification but BEFORE any effect.
    // Unconditional on purpose: the module decides for itself which legs need a proof (an out
    // leg passes, because the escrow it releases is a local balance this node is authoritative
    // over), so there is no branch here that could be gated wrong. ok:false applies NOTHING.
    const cross = verifyEscrowAgainstCheckpoint(row, ctx);
    if(!cross.ok){
        _warn('XBRIDGE', id, SETTLE_REASON.ESCROW_PROOF + ': ' + cross.reason + ' : skipping');
        return out(false, SETTLE_REASON.ESCROW_PROOF);
    }

    // DIRECTION IS DERIVED FROM THE ROW and is never a column (D19). The base spec states the
    // derivation outright: `src_chain === 'BTC'` is a LOCK, and a lock on the escrow chain is
    // what an in leg mints against. Everything else is a burn on the other side, whose escrow
    // this chain releases.
    //
    // Read through bridge_checkpoint_check's own escrow-chain constant rather than a literal,
    // and in the SAME direction the check reads it: the check exempts an out leg on
    // `thisChain === ESCROW_CHAIN` and refuses an in leg whose `src_chain` is not the escrow
    // chain, so a pass that derived direction any other way could hand the check a leg it
    // classifies the opposite way, and a mint would run with no cross-check at all. One
    // constant, one direction, one place to generalize when a non-BTC-origin token bridges.
    const isInLeg = (srcChain === cpCheck.ESCROW_CHAIN);
    const gasTick = ctx.config ? String(ctx.config['GAS']) : 'XCHAIN';
    const addresses = (ctx.config && ctx.config['ADDRESS']) || {};

    // Reset the per-action address/ticker lists the way processAction does for every other
    // handler: this pass mints its action directly (actions/xbridge.js returns a system-injected
    // v2/v5 untouched), so nothing else resets them, and a stale list would make updateBalances
    // recompute an unrelated address.
    util.resetLists();

    let localTick = tick;
    let credits = [], debits = [];

    if(isInLeg){
        // IN leg: this chain MINTS. The token row is created lazily by the first in-leg, which
        // is what keeps genesis byte-identical on every chain (base spec D8/D11).
        const genesis = new Genesis(ctx.actions, db, ctx.config, util);
        const injectCtx = { blockIndex: ctx.blockIndex, blockTime: ctx.blockTime, txHashPrefix: BRIDGE_TX_PREFIX };
        if(tick === gasTick){
            // The byte-identical _injectGasToken parameter set, taken from the ONE place that
            // owns it. Retyping the values here is the drift the helper exists to prevent
            // (D66): a drifted parameter is a different token row, which is a different
            // ledger hash on two chains.
            await genesis.injectProtocolToken(genesis.gasTokenParams(), injectCtx);
            localTick = gasTick;
        } else {
            const owner = addresses['BRIDGE_' + srcChain];
            if(_isNull(owner))
                return out(false, SETTLE_REASON.ESCROW_MISSING);
            const made = await genesis.injectBridgedToken(
                { origin: srcChain, name: tick, decimals: decimals, owner: owner }, injectCtx);
            if(!made.ok){
                _warn('XBRIDGE', id, SETTLE_REASON.TOKEN_ROW + ': ' + made.reason + ' : skipping');
                return out(false, SETTLE_REASON.TOKEN_ROW);
            }
            localTick = made.tick;
        }
        // A credit with no matching debit is what raises SUPPLY: updateTokens recomputes the
        // token's supply from credits minus debits, the same path MINT takes, so there is no
        // second supply write to keep in step.
        credits.push([localTick, amount, String(row.dest_address)]);
        util.addAddressTicker(String(row.dest_address), localTick);
    } else {
        // OUT leg: this chain is the ORIGIN and releases the escrow a lock put there. The
        // escrow is an ordinary balance at the keyless role address for the chain the units
        // were bridged TO, which is the row's src_chain (the burn happened there).
        const escrow = addresses['BRIDGE_' + srcChain];
        if(_isNull(escrow))
            return out(false, SETTLE_REASON.ESCROW_MISSING);
        const info = await db.getTokenInfo(localTick, ctx.blockIndex);
        if(!info)
            return out(false, SETTLE_REASON.TOKEN_ROW);
        // An escrow that would go NEGATIVE is a protocol violation, not a user error: apply
        // nothing and log exactly one line naming the transfer. A remote checkpoint can add
        // nothing here, because the local ledger IS the authority on a local balance.
        const balances = await db.getAddressBalances(escrow, null, ctx.blockIndex);
        if(!util.hasBalance(balances, info['TICK_ID'], amount)){
            _warn('XBRIDGE', id, SETTLE_REASON.ESCROW_SHORT + ' at ' + escrow + ' : skipping');
            return out(false, SETTLE_REASON.ESCROW_SHORT);
        }
        debits.push([localTick, amount, escrow]);
        credits.push([localTick, amount, String(row.dest_address)]);
        util.addAddressTicker(escrow, localTick);
        util.addAddressTicker(String(row.dest_address), localTick);
    }

    // Mint the internal settle action. Directly through createActionIndex and NEVER through
    // actions.processTransaction / processAction: actions/xbridge.js returns a system-injected
    // v2/v5 without writing a verdict, a row or a ledger effect, precisely so this pass is the
    // sole writer of the leg (the CROSS_SETTLE and XEXEC shape). FORMAT is 2 for the gas tick
    // and 5 for a general token, which is what the wire versions mean.
    const data = {
        ACTION:      'XBRIDGE',
        FORMAT:      (tick === gasTick) ? 2 : 5,
        BLOCK_INDEX: ctx.blockIndex,
        BLOCK_TIME:  ctx.blockTime
    };
    data['ACTION_INDEX'] = await db.createActionIndex({ ACTION: 'XBRIDGE', BLOCK_INDEX: ctx.blockIndex, FORMAT: data['FORMAT'] });
    data['STATUS'] = 'valid';

    _log('XBRIDGE v' + data['FORMAT'], id, (isInLeg ? 'mint ' : 'release ') + amount + ' ' +
         localTick + ' -> ' + row.dest_address + ' : ' + data['STATUS']);

    await util.processTransactionLedgerChanges(db, data, credits, debits, []);
    await db.updateBalances(Object.keys(util.getAddressesList()));
    await db.updateTokens(util.getTickersList());
    await recordSettlement(db, data['ACTION_INDEX'], id, 'transfer', ctx.blockIndex, row);
    // The seam's ctx carries `actions`, not `mapper`; the mapper hangs off it, the way every
    // handler reaches it. Accepting an explicit ctx.mapper too keeps a direct caller (a test,
    // a recovery path) from having to build a whole actions object for one method.
    await (ctx.mapper || ctx.actions.mapper).createMappings(data);

    return out(true, null, data['ACTION_INDEX']);
}

/**
 * Apply one finalized token policy snapshot to the bridged copy on this chain: the origin
 * row's allow list, block list and tick sleep, materialized as injected local actions.
 *
 * INJECTED LEGS, ORDINALS PINNED (consensus-visible, so the order is not a style choice):
 *   0 allow-list create or REMOVE, 1 allow-list ADD, 2 block-list create or REMOVE,
 *   3 block-list ADD, 4 ISSUE 5 (point the bridged row at the lists), 5 SLEEP.
 * Legs with nothing to do are not injected. One synthetic transaction per injected action,
 * _injectGasToken's field shape, tx_hash = 'XPOLICY-' + snapshot_id.slice(0, 48) and
 * vout = the leg's ordinal, so action indexes are identical on every node.
 *
 * MEMBERSHIP IS TRANSPORT, NOT SIGNATURE. allow_list and block_list arrive as JSON arrays
 * beside the row; the apply recomputes policy_hash from them and refuses the row with one
 * log line naming snapshot_id if it differs. It VERIFIES the arrays are already in
 * canonical order and refuses otherwise; it never re-sorts.
 *
 * TERMINAL versus CARRIED. Only a hash, signature, `network` or `btc_chain_id` failure is
 * terminal. Anything else - a seq not yet applyable, a missing earlier seq - carries
 * forward with one log line on the first block.
 *
 * NOT INHERITED: controller bindings (a binding names a contract deployed on one chain) and
 * address sleep (chain-local, not a token policy). The milestone-1 controller refusals stay.
 *
 * IDEMPOTENCY. Recorded in bridge_settlements with kind = 'policy' and the snapshot_id in
 * the transfer_id column, which is why `kind` is inside the unique key.
 *
 * NOT BUILT (lane L14).
 *
 * @param {Object} row - one finalized policy_snapshots row as mirrored: snapshot_id,
 *                       snapshot_block, origin_chain, tick, policy_seq, origin_block,
 *                       policy_hash, allow_list, block_list, sleeping, effective_time,
 *                       network, finalizing_view, validator_signatures, status,
 *                       push_generation, btc_chain_id
 * @param {Object} ctx - pass context, as applyBridgeTransfer
 * @returns {Promise<{applied: boolean, reason: (string|null), terminal: boolean,
 *          actionIndexes: Array<number>}>} terminal true means never retry this row
 */
async function applyPolicySnapshot(row, ctx){
    const out = (applied, reason, terminal, actionIndexes) =>
        ({ applied: applied, reason: reason, terminal: !!terminal, actionIndexes: actionIndexes || [] });

    if(!row || typeof row !== 'object' || !ctx || typeof ctx !== 'object')
        return out(false, SETTLE_REASON.ROW_FIELDS, true);

    const db   = ctx.indexerDb;
    const util = ctx.util;
    const id   = String(row.snapshot_id || '');

    const origin   = String(row.origin_chain || '');
    const name     = String(row.tick || '');
    const snapshot = _int(row.snapshot_block);
    const seq      = _int(row.policy_seq);
    if(!id || !origin || !name || snapshot === null || seq === null)
        return out(false, SETTLE_REASON.ROW_FIELDS, true);

    // TERMINAL versus CARRIED, and the split is the whole error policy of this function
    // (policy spec D19). Only a hash, signature, `network` or `btc_chain_id` failure is
    // terminal: those are properties of the ROW that no later block can change. Everything
    // else - a seq not yet applyable, a copy that does not exist here yet, a capability
    // snapshot still arriving - carries forward, because a later block can change it.
    if(String(row.network || '') !== String(ctx.network || ''))
        return out(false, SETTLE_REASON.NETWORK, true);
    const localChainId = ctx.config ? ctx.config['BTC_CHAIN_ID'] : null;
    if(!_isNull(row.btc_chain_id) && !_isNull(localChainId) &&
       String(row.btc_chain_id) !== String(localChainId))
        return out(false, SETTLE_REASON.CHAIN_ID, true);
    if(String(row.status || '') !== 'finalized')
        return out(false, SETTLE_REASON.NOT_FINALIZED, false);

    const blockTime = Number(ctx.blockTime);
    if(!Number.isFinite(blockTime) || Number(row.effective_time) > blockTime)
        return out(false, SETTLE_REASON.NOT_DUE, false);

    // The origin chain holds the native row; there is nothing to inherit onto itself.
    if(origin === String(ctx.coin || ''))
        return out(false, SETTLE_REASON.POLICY_ORIGIN, true);

    if(await isSettled(db, id, 'policy'))
        return out(false, SETTLE_REASON.ALREADY_APPLIED, false);

    // APPLY ORDER IS BY policy_seq, and it needs its own guard rather than riding the due-set
    // sort. effective_time is NOT monotonic across seq (D18), so seq 2 can become due at an
    // earlier block than seq 1: the per-block sort orders what is due TOGETHER and says nothing
    // about two snapshots that come due in different blocks. Applying them out of order
    // materializes the STALE membership last and leaves the copy enforcing a policy the origin
    // has already replaced, permanently. So an earlier finalized seq that this chain has not
    // recorded carries this row forward (D19: a missing earlier seq is CARRIED, never terminal).
    const earlier = await db._mirrorDb().doQuery(
        `SELECT snapshot_id FROM policy_snapshots
         WHERE status = 'finalized' AND network = ? AND origin_chain = ? AND tick = ? AND policy_seq < ?
         ORDER BY policy_seq ASC`,
        [String(row.network), origin, name, seq]);
    for(const e of (earlier || [])){
        if(!await isSettled(db, e.snapshot_id, 'policy')){
            _log('XPOLICY', id, SETTLE_REASON.POLICY_SEQ_GAP + ' : carrying forward');
            return out(false, SETTLE_REASON.POLICY_SEQ_GAP, false);
        }
    }

    // MEMBERSHIP IS TRANSPORT, NOT SIGNATURE. The arrays arrive beside the row and are bound
    // to it only through policy_hash, so the hash is recomputed from them here and a mismatch
    // refuses the row. Malformed transport is a hash-class failure: it cannot be read as an
    // empty list, because empty and absent mean opposite things under isActionAllowed (D7).
    const allow = parseMembership(row.allow_list);
    const block = parseMembership(row.block_list);
    if(allow === false || block === false){
        _warn('XPOLICY', id, SETTLE_REASON.POLICY_HASH + ' (membership transport is not a JSON array) : terminal');
        return out(false, SETTLE_REASON.POLICY_HASH, true);
    }
    // Order is VERIFIED, never repaired (D13). Re-sorting here would silently accept a row
    // whose hash the fleet computed over a different byte string.
    if(!verifyMembershipOrder(allow) || !verifyMembershipOrder(block)){
        _warn('XPOLICY', id, SETTLE_REASON.POLICY_ORDER + ' : terminal');
        return out(false, SETTLE_REASON.POLICY_ORDER, true);
    }
    const sleeping = !!_int(row.sleeping);
    if(policyHash(allow, block, sleeping) !== String(row.policy_hash || '').toLowerCase()){
        _warn('XPOLICY', id, SETTLE_REASON.POLICY_HASH + ' : terminal');
        return out(false, SETTLE_REASON.POLICY_HASH, true);
    }

    const quorum = await verifyQuorum(policyCanonical(row), row.validator_signatures,
                                      snapshot, row.network, db);
    if(quorum.snapshotAbsent){
        _log('XPOLICY', id, SETTLE_REASON.SNAPSHOT_ABSENT + ' : deferring');
        return out(false, SETTLE_REASON.SNAPSHOT_ABSENT, false);
    }
    if(!quorum.met){
        _warn('XPOLICY', id, SETTLE_REASON.QUORUM + ' (' + quorum.valid + '/' + quorum.total + ') : terminal');
        return out(false, SETTLE_REASON.QUORUM, true);
    }

    // The bridged copy on THIS chain. A chain that holds no copy of the tick has nothing to
    // materialize the policy onto, and that is a CARRIED outcome: a copy can appear later, on
    // the first in-leg of a transfer of that tick.
    const copyTick = origin + '.' + name;
    const owner    = ((ctx.config && ctx.config['ADDRESS']) || {})['BRIDGE_' + origin];
    const tickId   = await db.getTickerId(copyTick);
    if(_isNull(tickId) || _isNull(owner))
        return out(false, SETTLE_REASON.POLICY_NO_COPY, false);
    const info = await db.getTokenInfo(copyTick, ctx.blockIndex);
    if(!info)
        return out(false, SETTLE_REASON.POLICY_NO_COPY, false);

    util.resetLists();

    const actionIndexes = [];
    // Each leg is a synthetic transaction of its own, tx_hash = 'XPOLICY-' + 48 characters of
    // the snapshot id and vout = the leg's PINNED ordinal, so every node assigns the same
    // action index to the same leg. Routed through processTransaction(tx, true), which stamps
    // IS_GENESIS: that flag is what exempts the injected SLEEP from the copy's LOCK_SLEEP and
    // the injected edits from the bridge-owned LIST refusal. No broadcast action ever carries
    // it, so no historical verdict moves.
    const inject = async (fields, ordinal) => {
        const tx = {
            data:          fields.join('|'),
            source:        owner,
            destination:   null,
            amount:        null,
            tx_hash:       POLICY_TX_PREFIX + id.slice(0, 48),
            vout:          ordinal,
            block_index:   ctx.blockIndex,
            block_time:    ctx.blockTime,
            raw_data:      null,
            fee:           null,
            source_pubkey: null,
            tx_outputs:    []
        };
        const applied = await ctx.actions.processTransaction(tx, true);
        if(applied && applied['ACTION_INDEX'] !== undefined && applied['ACTION_INDEX'] !== null)
            actionIndexes.push(Number(applied['ACTION_INDEX']));
        return applied;
    };

    // One list's legs: create it with the full membership when the copy has none, otherwise
    // bring the existing list to the new membership with edits. A LIST format 1 carries ONE
    // edit verb for the whole action (list.js:51), so a change with both removals and
    // additions is two actions, which is exactly why the removal and the addition have
    // separate ordinals. A null target injects nothing at all and leaves the copy's field
    // NULL: an absent origin list is no gate, and materializing it as an EMPTY list would
    // turn it into deny-everyone (D7).
    const applyList = async (target, existingIndex, createOrRemoveOrdinal, addOrdinal) => {
        if(target === null) return { created: null };
        if(_isNull(existingIndex)){
            const created = await inject(['LIST', '0', LIST_TYPE_ADDRESS, ''].concat(target), createOrRemoveOrdinal);
            if(!created || created['STATUS'] !== 'valid') return { created: false };
            return { created: Number(created['ACTION_INDEX']) };
        }
        const current = await db.getList(existingIndex, ctx.blockIndex);
        const have    = new Set((current || []).map(String));
        const want    = new Set(target.map(String));
        const remove  = [...have].filter(a => !want.has(a));
        const add     = target.filter(a => !have.has(String(a)));
        if(remove.length){
            const r = await inject(['LIST', '1', LIST_EDIT_REMOVE, String(existingIndex), ''].concat(remove), createOrRemoveOrdinal);
            if(!r || r['STATUS'] !== 'valid') return { created: false };
        }
        if(add.length){
            const a = await inject(['LIST', '1', LIST_EDIT_ADD, String(existingIndex), ''].concat(add), addOrdinal);
            if(!a || a['STATUS'] !== 'valid') return { created: false };
        }
        return { created: null };
    };

    // A leg the chain REFUSED is neither of D19's carried cases (those are about ordering) and
    // it is not one of its terminal ones either, so the rule has to be reasoned out rather than
    // looked up. It turns on whether a retry could duplicate work:
    //   - nothing landed yet: nothing to duplicate, so CARRY. A later block retries for free.
    //   - something landed:   a retry would re-create the list it already created, because the
    //                         pointer that would have made the second run see it is exactly the
    //                         leg that failed. That loop mints fresh action indexes on every
    //                         node on every block, forever. So the snapshot is RECORDED and
    //                         never retried, loudly: the cross_settle rule that a row which can
    //                         no longer progress is recorded so it stops being re-evaluated.
    // The copy is then left with whatever legs did land and no pointer; the applied-policy read
    // and the invariant watch are what surface it.
    const legFailure = async (which) => {
        if(actionIndexes.length === 0){
            _warn('XPOLICY', id, SETTLE_REASON.POLICY_LEG + ' (' + which + ') : nothing applied, carrying forward');
            return out(false, SETTLE_REASON.POLICY_LEG, false, actionIndexes);
        }
        _warn('XPOLICY', id, SETTLE_REASON.POLICY_LEG + ' (' + which + ') : ' + actionIndexes.length +
              ' leg(s) already applied, recording so the pass cannot re-inject them');
        await recordSettlement(db, actionIndexes[actionIndexes.length - 1], id, 'policy', ctx.blockIndex,
                               { src_chain: origin, src_action_index: null, dest_chain: ctx.coin,
                                 dest_address: null, tick: name });
        return out(false, SETTLE_REASON.POLICY_LEG, true, actionIndexes);
    };

    const allowRes = await applyList(allow, info['ALLOW_LIST'],
                                     POLICY_LEG_ORDINAL.ALLOW_CREATE_OR_REMOVE, POLICY_LEG_ORDINAL.ALLOW_ADD);
    if(allowRes.created === false)
        return await legFailure('allow list');
    const blockRes = await applyList(block, info['BLOCK_LIST'],
                                     POLICY_LEG_ORDINAL.BLOCK_CREATE_OR_REMOVE, POLICY_LEG_ORDINAL.BLOCK_ADD);
    if(blockRes.created === false)
        return await legFailure('block list');

    // ISSUE 5 points the bridged row at the lists, and is injected ONLY when a list was
    // created this snapshot: an edit writes under the edit's own action index and never moves
    // the pointer, and an ISSUE 5 with both fields empty back-fills both from the current row
    // (issue.js), so injecting it unconditionally would be a leg that does nothing and still
    // consumes an action index on every node.
    if(allowRes.created !== null || blockRes.created !== null){
        const point = await inject(['ISSUE', '5', copyTick,
                                    allowRes.created === null ? '' : String(allowRes.created),
                                    blockRes.created === null ? '' : String(blockRes.created)],
                                   POLICY_LEG_ORDINAL.ISSUE_POINT);
        if(!point || point['STATUS'] !== 'valid')
            return await legFailure('ISSUE 5');
    }

    // Tick sleep. The origin's own resume_block is NOT carried: heights are not comparable
    // across chains. `sleeping` true injects resume_block -1 (indefinite); false injects the
    // CURRENT block, which reads awake at that block and after (db.js sleeps only on -1 or a
    // future block, and sleep.js admits equality). Injected only when the state would change,
    // so a snapshot that says nothing new about sleep costs no action index.
    const isAsleep = await db.isTickSleeping(copyTick, ctx.blockIndex);
    if(!!isAsleep !== sleeping){
        const slept = await inject(['SLEEP', '1', sleeping ? '-1' : String(ctx.blockIndex), copyTick],
                                   POLICY_LEG_ORDINAL.SLEEP);
        if(!slept || slept['STATUS'] !== 'valid')
            return await legFailure('SLEEP');
    }

    // The idempotency record is anchored to an action index so a destination reorg below the
    // applying block drops it with the legs and the snapshot re-applies at fresh indexes. When
    // every leg was a no-op there is no leg index to anchor to, so the record anchors to a
    // minted XPOLICY action: without it the snapshot would be re-evaluated on every later
    // block forever. A snapshot with nothing to do is ordinary, not exotic (seq 1 of a tick
    // with no lists that is awake), so this path is reached in normal operation.
    //
    // 'XPOLICY' is an internal action name, not a wire action: no decoder produces it, nothing
    // dispatches it, and it is never broadcast. It interns in index_actions the way every
    // action name does, at the same point on every node, and nothing keys a verdict or a hash
    // input on the name itself.
    let anchor = actionIndexes.length ? actionIndexes[actionIndexes.length - 1] : null;
    if(anchor === null){
        anchor = await db.createActionIndex({ ACTION: 'XPOLICY', BLOCK_INDEX: ctx.blockIndex, FORMAT: 0 });
        actionIndexes.push(anchor);
    }

    // No ledger reconciliation here on purpose: a policy leg moves no units, and each injected
    // LIST / ISSUE / SLEEP already ran through its own handler, which does whatever balance and
    // supply work it owns. A sweep here would re-read whichever addresses the LAST leg happened
    // to leave in the shared list, which is not a set this pass has any claim about.
    await recordSettlement(db, anchor, id, 'policy', ctx.blockIndex,
                           { src_chain: origin, src_action_index: null, dest_chain: ctx.coin,
                             dest_address: null, tick: name });

    _log('XPOLICY', id, 'applied seq ' + seq + ' to ' + copyTick + ' (' + actionIndexes.length + ' legs)');
    return out(true, null, false, actionIndexes);
}

/**
 * THE D2 HOOK: prove the source-chain escrow behind a transfer against the anchored BTC
 * state checkpoint before the destination mints.
 *
 * WHY IT EXISTS. Milestone 1 is a hub-trusted mint: off the origin chain the hub supplies
 * both the transfer record and the capability roster that verifies it, so a compromised hub
 * can mint on the destination with nothing held on the origin. This check reduces the
 * assumption to "the cross_chain quorum AND the checkpoint quorum both lied", which is the
 * assumption the cross-chain DEX and every validator action already rest on. Nothing arms
 * on mainnet before it is built.
 *
 * THE PROOF IS TRANSPORT, NEVER A CANONICAL FIELD. It is fetched beside the row or by the
 * indexer itself (the anchor proof client), and is NOT part of the signed content canonical.
 * That is what lets D2 land later without changing one canonical or invalidating one
 * signature: every canonical field is a byte-match obligation forever.
 *
 * WHAT IT PROVES. The escrow balance at row.snapshot_block, proven against the balances_root
 * the anchored BTC checkpoint carries at that height. The escrow is an ordinary balance at
 * ADDRESS.BRIDGE_<dest_chain>, so it rides that root with no new subtree.
 *
 * NO LONGER A STUB. The seam shipped this returning ok:true so the hook could be called
 * unconditionally while the real check was still being built; it now delegates, and the
 * delegation is the whole body on purpose. Keeping one named door here means the settle pass
 * has exactly one call site to audit and the check keeps its own file, its own suite and its
 * own falsification drill. ctx.proof is populated by fetchProofForTransfer below BEFORE this
 * runs; a caller that supplies none gets the check's own PROOF_MISSING refusal, which is the
 * fail-closed direction.
 *
 * @param {Object} row - the bridge_transfers row about to be applied, as applyBridgeTransfer
 * @param {Object} ctx - pass context, plus { proof } when the caller fetched one beside the
 *                       row; the pass driver always fetches one for a leg that needs it
 * @returns {{ok: boolean, reason: string}} ok false refuses the row with one log line naming
 *          the transfer_id and applies nothing
 */
function verifyEscrowAgainstCheckpoint(row, ctx){
    // BUILT. The permissive stub is gone: the real check lives in bridge_checkpoint_check.js
    // (lane L17) and this is the one door into it, so the settle pass calls one name and the
    // check keeps its own file, its own tests and its own falsification drill.
    return cpCheck.verifyEscrowAgainstCheckpoint(row, ctx);
}

/**
 * Build ctx.proof for one transfer, or STALL the whole pass.
 *
 * WHY THE PASS AND NOT THE CHECK FETCHES IT. bridge_checkpoint_check.js is synchronous and
 * pure by design, so it cannot make two nodes disagree because one of them had a slower
 * database. That makes the fetch the CALLER's obligation, and it comes with the caller's two
 * rules, both discharged in bridge_proof_client.js: the checkpoint is selected
 * deterministically, and it is one this node has already established as quorum-signed.
 *
 * A PROOF THAT CANNOT BE OBTAINED YET STALLS, and that distinction is the reason this throws
 * instead of returning. "My mirror has not caught up" is a property of one node's network,
 * while ok:false is a consensus verdict that this row never applies here. Letting an absence
 * read as a refusal would let a node that is merely behind decide, permanently, that a
 * legitimate transfer was forged. The error escapes the pass and the block loop defers the
 * block under bridge_proof_barrier, beside waitForBridgeSync.
 *
 * OUT LEGS NEED NO PROOF and are not stalled for one: the escrow an out leg releases is an
 * ordinary balance on THIS chain, where the local ledger is authoritative and the
 * would-go-negative refusal is the guard. The exemption is keyed on the check module's own
 * escrow-chain constant and derived exactly as the check derives it, so the two can never
 * disagree about which leg needs a proof.
 *
 * @param {Object} row - the bridge_transfers row about to be applied
 * @param {Object} ctx - the pass context
 * @returns {Promise<Object|null>} the envelope for ctx.proof, or null when none is needed
 * @throws {BridgeProofUnavailableError}
 */
async function fetchProofForTransfer(row, ctx){
    const srcChain  = String(row.src_chain || '');
    const destChain = String(row.dest_chain || '');
    const thisChain = String(ctx.coin || '');
    // Not our leg, or an out leg: the check answers those from the row alone.
    if(thisChain !== destChain || thisChain === cpCheck.ESCROW_CHAIN) return null;
    // A source chain that is not the escrow chain is refused by the check itself (IN_LEG_ORIGIN)
    // and is not worth a network round trip.
    if(srcChain !== cpCheck.ESCROW_CHAIN) return null;

    const escrow = cpCheck.resolveEscrowAddress(srcChain, destChain, String(row.network || ''));
    // An unresolvable escrow address is a CONFIG fact, identical on every node running this
    // build, so it is the check's refusal (ESCROW_UNRESOLVED) and not a stall.
    if(!escrow) return null;

    return await proofClient.buildEscrowProof(row, ctx, escrow);
}

/**
 * The end-of-block settle pass. XChainIndexer.js calls this in its PINNED position,
 * immediately after util.processCrossChainSettlements and before util.processCrossChainCalls.
 *
 * ORDER INSIDE THE PASS is pinned too: policy snapshots run at the HEAD, then the transfer
 * legs. A snapshot materialized after a credit in the same block would gate that credit under
 * the OLD membership on a node that ordered it the other way.
 *
 * CAPS AND CARRY-FORWARD. XPOLICY_MAX_PER_BLOCK snapshots and XBRIDGE_MAX_PER_BLOCK transfers
 * per block, the overflow carrying forward IN ORDER and never dropped: a dropped row would
 * make the applied set depend on which rows a node happened to hold, and the cutoff is
 * consensus-visible because it decides which action indexes exist.
 *
 * @param {Object} ctx - { actions, indexerDb, util, config, coin, network, blockIndex, blockTime }
 * @returns {Promise<{policies: Array<string>, transfers: Array<string>}>} the ids applied
 * @throws {BridgeProofUnavailableError} when a proof is not obtainable yet: DEFER the block
 */
async function processBridgeSettlePass(ctx){
    const applied = { policies: [], transfers: [] };
    for(const row of await duePolicySnapshots(ctx)){
        const res = await applyPolicySnapshot(row, ctx);
        if(res.applied) applied.policies.push(row.snapshot_id);
    }
    for(const row of await dueBridgeTransfers(ctx)){
        ctx.proof = await fetchProofForTransfer(row, ctx);
        const res = await applyBridgeTransfer(row, ctx);
        if(res.applied) applied.transfers.push(row.transfer_id);
    }
    delete ctx.proof;
    return applied;
}

/**
 * The finalized, effective, unapplied transfers whose destination is THIS chain, in
 * (snapshot_block, transfer_id) order, capped.
 *
 * ORDERED ON QUORUM-AGREED ROW CONTENT and never on the hub-assigned AUTO_INCREMENT `id`,
 * which is per-hub: two indexers mirroring different hubs must settle the same prefix, and an
 * id-ordered query would give them different ones. The same rule getEffectiveUnsettledMatches
 * follows, for the same reason.
 */
async function dueBridgeTransfers(ctx){
    const db   = ctx.indexerDb;
    const rows = await db._mirrorDb().doQuery(
        `SELECT * FROM bridge_transfers
         WHERE status = 'finalized' AND network = ? AND effective_time <= ? AND dest_chain = ?
         ORDER BY snapshot_block ASC, transfer_id ASC`,
        [String(ctx.network), Number(ctx.blockTime), String(ctx.coin)]);
    if(rows.length === 0) return [];
    const ids = rows.map(r => r.transfer_id);
    const settled = await db.doQuery(
        `SELECT transfer_id FROM bridge_settlements
         WHERE kind = 'transfer' AND transfer_id IN (${ids.map(() => '?').join(',')})`, ids);
    const seen = new Set(settled.map(r => r.transfer_id));
    return rows.filter(r => !seen.has(r.transfer_id))
               .slice(0, XBRIDGE_MAX_PER_BLOCK || 25);
}

/**
 * The finalized, effective, unapplied policy snapshots, capped.
 *
 * THE ORDER IS (snapshot_block, snapshot_id) ACROSS TICKS AND policy_seq WITHIN ONE TICK, and
 * those two rules need reconciling into one TOTAL order or the per-block cutoff is not
 * node-invariant. Reconciled by ranking each (origin_chain, tick) group by its LOWEST
 * snapshot_id inside a snapshot_block, then ordering within a group by policy_seq. Both spec
 * rules hold, the comparator is a real total order (the group rank is precomputed, so no pair
 * of comparisons can contradict), and two ticks never interleave, which is what the seq rule
 * is for: a tick's seq 2 can never be applied before its seq 1.
 */
async function duePolicySnapshots(ctx){
    const db   = ctx.indexerDb;
    const rows = await db._mirrorDb().doQuery(
        `SELECT * FROM policy_snapshots
         WHERE status = 'finalized' AND network = ? AND effective_time <= ?`,
        [String(ctx.network), Number(ctx.blockTime)]);
    if(rows.length === 0) return [];

    const groupRank = new Map();
    for(const r of rows){
        const key  = String(r.origin_chain) + '|' + String(r.tick);
        const prev = groupRank.get(key);
        const sid  = String(r.snapshot_id);
        if(prev === undefined || sid < prev) groupRank.set(key, sid);
    }
    rows.sort((a, b) => {
        const ba = Number(a.snapshot_block), bb = Number(b.snapshot_block);
        if(ba !== bb) return ba - bb;
        const ka = String(a.origin_chain) + '|' + String(a.tick);
        const kb = String(b.origin_chain) + '|' + String(b.tick);
        if(ka !== kb){
            const ra = groupRank.get(ka), rb = groupRank.get(kb);
            if(ra !== rb) return ra < rb ? -1 : 1;
            return ka < kb ? -1 : 1;
        }
        return Number(a.policy_seq) - Number(b.policy_seq);
    });

    const ids = rows.map(r => r.snapshot_id);
    const settled = await db.doQuery(
        `SELECT transfer_id FROM bridge_settlements
         WHERE kind = 'policy' AND transfer_id IN (${ids.map(() => '?').join(',')})`, ids);
    const seen = new Set(settled.map(r => r.transfer_id));
    return rows.filter(r => !seen.has(r.snapshot_id))
               .slice(0, XPOLICY_MAX_PER_BLOCK || 5);
}

module.exports = {
    applyBridgeTransfer,
    applyPolicySnapshot,
    verifyEscrowAgainstCheckpoint,
    processBridgeSettlePass,
    fetchProofForTransfer,
    dueBridgeTransfers,
    duePolicySnapshots,
    transferCanonical,
    policyCanonical,
    policyHash,
    verifyMembershipOrder,
    parseMembership,
    verifyQuorum,
    isSettled,
    recordSettlement,
    SETTLE_REASON,
    POLICY_LEG_ORDINAL,
    POLICY_TX_PREFIX,
    BRIDGE_TX_PREFIX,
};
