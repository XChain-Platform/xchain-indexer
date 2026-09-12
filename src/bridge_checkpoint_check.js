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
 * XChain Platform - D2: the escrow cross-check against the anchored state checkpoint.
 *
 * WHAT THIS IS. The trust boundary of the bridge. Milestone 1 is a hub-trusted mint: off
 * the origin chain the hub supplies BOTH the transfer record and the capability roster
 * that verifies it, so a compromised hub can mint on the destination with nothing held in
 * escrow on the origin. This module makes the destination indexer prove, before it mints,
 * that the origin chain's own quorum-signed state checkpoint agrees that the escrow holds
 * at least what is about to be minted. That reduces the assumption to "the cross_chain
 * quorum AND the checkpoint quorum both lied", the assumption the cross-chain DEX and every
 * validator action already rest on. Nothing arms on mainnet before this is built.
 * Spec: the base bridge spec sections 5, 8, 12 and work row 17; D2, D19, D46.
 *
 * THE PROOF IS TRANSPORT, NEVER A CANONICAL FIELD (D19). It arrives in ctx.proof, fetched
 * beside the row or by the indexer itself, and is no part of the signed content canonical.
 * That is exactly what lets D2 land without changing one canonical or invalidating one
 * signature: every canonical field is a byte-match obligation forever. Nothing in here
 * reads or writes a signed field, and nothing in here is signed.
 *
 * WHY A BALANCE PROOF AND NOT A NEW COMMITMENT (D46). The escrow is an ordinary balance at
 * ADDRESS.BRIDGE_<dest_chain> on the origin chain, so it already rides balances_root, which
 * already rides the state_root the checkpoint quorum signs. No new subtree, no new hash
 * input, no flag day for the commitment itself.
 *
 * THE CHAIN OF BINDINGS this module checks, each one of which a forgery has to break:
 *   1. the leg is an IN leg (this chain is dest_chain), derived from the row, never a column
 *   2. the proof names THIS transfer's chain, network, tick and the escrow address this
 *      module resolves itself from the origin chain's coin config (never the envelope's)
 *   3. the checkpoint is for the origin chain and network, and is at or after snapshot_block
 *   4. the checkpoint's state_root_version is the version this node DERIVES at that
 *      checkpoint's own height for that chain and network, the way the fleet mints it
 *   5. the sub-roots in the envelope reassemble EXACTLY to the checkpoint's state_root
 *   6. the balance leaf this module derives from the claimed balance is proven under
 *      balances_root at the key this module derives
 *   7. the proven balance is at least the transfer amount
 * A proof that is absent, stale, malformed or fails any binding returns ok:false and the
 * row applies nothing.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO, and whose job it is. It does not verify the
 * checkpoint's own validator signatures, and it does not choose the checkpoint. Both are the
 * CALLER's obligation and both are load-bearing:
 *   - the caller must pass a checkpoint it has already established as quorum-signed: an
 *     anchor_actions row parsed from an on-chain ANCHOR v0 bundle with status 'valid' (the
 *     strongest source, because the local handler verified the quorum at parse time from
 *     chain data), or a mirrored state_checkpoints row re-verified against the capability
 *     snapshot at the checkpoint's own snapshot_block. Handing this module an unverified
 *     checkpoint makes the cross-check vacuous, because a hub that can forge the transfer
 *     can then forge the root it is proven against.
 *   - the caller must select the checkpoint DETERMINISTICALLY: the first checkpoint at or
 *     after row.snapshot_block for (row.src_chain, row.network), highest checkpoint_seq at
 *     that height. Two nodes that pick different checkpoints, or that differ on whether one
 *     is present yet, produce different verdicts for the same row at the same height, and a
 *     verdict that decides whether an action index is assigned is consensus-visible. A
 *     checkpoint not yet held locally must therefore stall the pass, the way
 *     waitForSnapshotSync already stalls it for the roster, and never read as "refuse".
 * Keeping the signature rule out of here is also what keeps the XCHECKPOINT canonical to its
 * existing four byte-matched copies; a fifth copy inside a verifier is a fork waiting to
 * happen.
 *
 ********************************************************************/

'use strict';

const M = require('./merkle.js');
// The state_root layout version is a DERIVED quantity, per height, chain and network. This
// is the same module the block path and getblockhashes derive it from, so this check and the
// value the fleet stamps into the signed checkpoint cannot come apart.
const stateSubtree = require('./state_subtree_activation.js');

// Role prefix of the escrow address on the ORIGIN chain: one protocol address per
// destination chain, ADDRESS.BRIDGE_<DEST_COIN> (spec section 5). Unspendable because no
// key exists, which is what lets it be an ordinary balance rather than an escrow row.
const ESCROW_ROLE_PREFIX = 'BRIDGE_';

// The chain the escrow lives on for this milestone's tick. XCHAIN is minted on BTC and
// nowhere else, v0 locks are BTC only and v1 burns are non-BTC only (spec section 4), so the
// escrow addresses are roles in the BTC coin bundle and the leg follows from src_chain alone.
// The token bridge generalizes this to the tick's OWN origin chain; that generalization is
// its lane's, not this one's, and the constant is named here so it is a one-line change
// rather than a hunt through the conditions.
const ESCROW_CHAIN = 'BTC';

// Failure classes. These are LOG reasons, not consensus verdict strings: no wire action's
// STATUS is built from them and no canonical carries them, so they can be read for what
// they are. The boolean beside them is the consensus-visible part.
const ESCROW_PROOF_REASON = {
    VERIFIED:            'escrow proven against the checkpoint',
    OUT_LEG:             'out leg: the escrow is a local balance on this chain',
    NOT_THIS_CHAIN:      'transfer names neither side as this chain',
    IN_LEG_ORIGIN:       'in leg does not originate on the escrow chain',
    ROW_FIELDS:          'transfer row is missing fields the cross-check needs',
    ROW_NETWORK:         'transfer network does not match this indexer',
    ROW_AMOUNT:          'transfer amount is not a positive decimal',
    PROOF_MISSING:       'escrow proof missing',
    PROOF_MALFORMED:     'escrow proof malformed',
    PROOF_BINDING:       'escrow proof is not bound to this transfer',
    ESCROW_UNRESOLVED:   'escrow address unresolved on the origin chain',
    CHECKPOINT_MISSING:  'proof carries no checkpoint',
    CHECKPOINT_BINDING:  'checkpoint is not the origin chain and network of this transfer',
    CHECKPOINT_STALE:    'checkpoint is below the transfer snapshot_block',
    CHECKPOINT_ROOTLESS: 'checkpoint carries no state_root',
    ROOT_VERSION:        'checkpoint state_root version is not the version derived at that height',
    ROOT_MISMATCH:       'sub-roots do not reassemble to the checkpoint state_root',
    PROOF_INVALID:       'balance proof does not verify under balances_root',
    INSUFFICIENT:        'proven escrow balance is below the transfer amount',
};

function _fail(reason){ return { ok: false, reason: reason }; }
function _pass(reason){ return { ok: true,  reason: reason }; }

// A non-empty string, or null. Used for every field taken off the row or the envelope:
// a number, a Buffer or an object where a chain or an address belongs is malformed input,
// not something to String() into a key preimage.
function _str(v){
    if(typeof v !== 'string') return null;
    const s = v.trim();
    return s.length ? s : null;
}

// A finite non-negative integer height, or null. Heights arrive from a MariaDB driver that
// may hand back a number, a string or a BigInt depending on its bigint options, so the
// conversion is pinned here rather than trusted from the call site.
function _height(v){
    if(v === null || v === undefined) return null;
    if(typeof v === 'bigint') return (v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(v) : null;
    const n = Number(v);
    if(!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
    return n;
}

// A strict non-negative version integer, or null. Deliberately NOT a bare Number(): that
// reads true as 1, ' 1 ' as 1 and null as 0, so a field that is not a version at all would
// compare equal to a derived version of 1 and pass. Shape follows _strictHeight in
// state_subtree_activation.js, plus the BigInt case the MariaDB driver can hand back.
function _version(v){
    if(typeof v === 'bigint')
        return (v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(v) : null;
    const n = (typeof v === 'number') ? v
            : (typeof v === 'string' && /^\d+$/.test(v)) ? Number(v)
            : NaN;
    return (Number.isInteger(n) && n >= 0) ? n : null;
}

// A canonical amount scaled to an exact 18-dp integer, or null when the input is not a
// non-negative decimal. BigInt rather than mathjs: the comparison is exact, and it cannot
// depend on a bignumber config that the producer of the proof does not share.
function _scaled(amount){
    if(typeof amount !== 'string' && typeof amount !== 'number') return null;
    let canon;
    try { canon = M.canonicalAmount(String(amount).trim()); }
    catch(e){ return null; }
    const [i, f] = canon.split('.');
    return BigInt(i) * 1000000000000000000n + BigInt(f);
}

/**
 * The escrow address on `originChain` that backs transfers to `destChain`, read through the
 * SAME door the lock handler credits: the origin coin's indexer config ADDRESS block. One
 * door on purpose. If the resolver and the handler read different sources they can disagree,
 * and a cross-check that proves the balance of an address nothing was ever credited to is
 * worse than no cross-check at all.
 *
 * Returns null when the role is absent, which fails the check closed rather than proving
 * some other address.
 *
 * @param {string} originChain - the chain that holds the escrow (the transfer's src_chain)
 * @param {string} destChain   - the chain the units are bridged to
 * @param {string} network     - mainnet / testnet / regtest
 * @returns {string|null}
 */
function resolveEscrowAddress(originChain, destChain, network){
    const chain = _str(originChain), dest = _str(destChain), net = _str(network);
    if(!chain || !dest || !net) return null;
    if(!/^[A-Z]{2,10}$/.test(chain) || !/^[A-Z]{2,10}$/.test(dest)) return null;
    let conf;
    try { conf = require('./configs/' + chain + '.js').getConfig(net); }
    catch(e){ return null; }
    const addresses = (conf && (conf.ADDRESS || conf.address)) || {};
    return _str(addresses[ESCROW_ROLE_PREFIX + dest]);
}

/**
 * THE D2 HOOK. Prove the origin-chain escrow behind a transfer against the state checkpoint
 * the origin chain's quorum signed, before this chain mints.
 *
 * Synchronous and pure by design: everything it needs is the row plus the envelope the
 * caller fetched beside it, so the check itself performs no I/O and cannot make two nodes
 * disagree because one of them had a slower database.
 *
 * ctx.proof envelope, which is TRANSPORT and mirrors what a producer reads straight out of
 * its own state_tree_roots and checkpoint tables:
 *   {
 *     chain, network,            the origin chain and network the roots belong to
 *     block_index,               the origin height the roots commit
 *     sub_roots: {               every named sub-root committed at that height; an absent
 *       balances_root,           or empty slot is the empty-SMT root, exactly as the
 *       stakes_root, ...         producer's assembly treats it
 *     },
 *     address, tick, balance,    the escrow balance being claimed, as a decimal string
 *     balance_proof: {           an SMT proof under balances_root: either the 256 explicit
 *       siblings | compressed    siblings or the compressed wire form. leaf_value in the
 *     },                         envelope is IGNORED; the leaf is derived from `balance`
 *     checkpoint: {              the quorum-signed checkpoint the caller already verified
 *       chain, network, block_index, checkpoint_seq, snapshot_block,
 *       state_root, state_root_version   as SIGNED, so the version is the one the origin
 *     }                                  chain derived at block_index, not a static constant
 *   }
 *
 * OBLIGATION ON WHOEVER BUILDS THE PRODUCER, and it is not optional. `sub_roots` must carry
 * EVERY sub-root the checkpoint's own version commits, because the binding here is a full
 * reassembly to the signed state_root. A version-2 chain with real contract state commits a
 * non-empty contract_state_root, so an envelope carrying only the v1 pair reassembles to a
 * different root and the transfer is refused. The indexer's `state_tree_roots` row holds all
 * of them, so a producer reading beside the row satisfies this for free; the explorer's
 * public SPV endpoint does NOT, since it serves balances_root and stakes_root plus a
 * `sub_root_path` proving balances_root under state_root, which is a different binding and
 * a different envelope shape (`height`, `amount`, `smt_proof`). Mapping that surface onto
 * this one is the proof client's job, and dropping slots on the way is a silent refusal.
 *
 * @param {Object} row - the bridge_transfers row about to be applied
 * @param {Object} ctx - pass context { actions, indexerDb, util, config, coin, network,
 *                       blockIndex, blockTime }, plus { proof } when the caller fetched one
 * @returns {{ok: boolean, reason: string}} ok false applies nothing and is what the single
 *          log line naming the transfer_id reports
 */
function verifyEscrowAgainstCheckpoint(row, ctx){
    if(!row || typeof row !== 'object' || !ctx || typeof ctx !== 'object')
        return _fail(ESCROW_PROOF_REASON.ROW_FIELDS);

    const srcChain  = _str(row.src_chain);
    const destChain = _str(row.dest_chain);
    const rowNet    = _str(row.network);
    const tick      = _str(row.tick);
    const snapshot  = _height(row.snapshot_block);
    const thisChain = _str(ctx.coin);
    const ctxNet    = _str(ctx.network);
    if(!srcChain || !destChain || !rowNet || !tick || snapshot === null || !thisChain || !ctxNet)
        return _fail(ESCROW_PROOF_REASON.ROW_FIELDS);
    if(srcChain === destChain)
        return _fail(ESCROW_PROOF_REASON.ROW_FIELDS);

    // The transfer must be for the network this indexer is on. A foreign-network row is
    // refused outright by the settle pass too; it is re-checked here because every key and
    // every root below is network-scoped, so proceeding on a mismatch would prove a balance
    // on a chain this node is not indexing.
    if(rowNet !== ctxNet)
        return _fail(ESCROW_PROOF_REASON.ROW_NETWORK);

    // The settle pass applies THIS chain's leg, and that is always the destination leg: an
    // in leg mints here from a lock on the escrow chain, an out leg releases escrow here
    // from a burn on the other side. A row naming neither side as this chain is not ours.
    if(thisChain !== destChain) return _fail(ESCROW_PROOF_REASON.NOT_THIS_CHAIN);

    // Direction is DERIVED and is never a column (D19). The OUT leg releases an escrow that
    // is an ordinary balance on this very chain, where the local ledger is authoritative and
    // the would-go-negative refusal in the settle pass is the guard: a remote checkpoint can
    // add nothing to a balance this node holds itself.
    if(thisChain === ESCROW_CHAIN) return _pass(ESCROW_PROOF_REASON.OUT_LEG);

    // Everything else is an IN leg: this chain is about to MINT, so it needs the proof. The
    // exemption is keyed on THIS chain being the escrow chain and never on the row's
    // src_chain, and that ordering is the whole point. Read the other way round, a forged row
    // naming any non-escrow source chain would derive as an "out leg" and mint here with no
    // cross-check at all, which is precisely the forgery D2 exists to stop. A mint can only
    // come from a lock on the escrow chain, so a source chain that is not it is refused.
    if(srcChain !== ESCROW_CHAIN) return _fail(ESCROW_PROOF_REASON.IN_LEG_ORIGIN);

    const amount = _scaled(row.amount);
    if(amount === null || amount <= 0n)
        return _fail(ESCROW_PROOF_REASON.ROW_AMOUNT);

    const proof = ctx.proof;
    if(!proof || typeof proof !== 'object')
        return _fail(ESCROW_PROOF_REASON.PROOF_MISSING);

    const cp = proof.checkpoint;
    if(!cp || typeof cp !== 'object')
        return _fail(ESCROW_PROOF_REASON.CHECKPOINT_MISSING);

    // The checkpoint must be the ORIGIN chain's, on this network. A checkpoint of the
    // destination chain proves nothing about the escrow, and one of another network proves
    // a balance in another ledger entirely.
    if(_str(cp.chain) !== srcChain || _str(cp.network) !== rowNet)
        return _fail(ESCROW_PROOF_REASON.CHECKPOINT_BINDING);

    const cpHeight = _height(cp.block_index);
    if(cpHeight === null)
        return _fail(ESCROW_PROOF_REASON.CHECKPOINT_BINDING);

    // STALENESS. snapshot_block is the origin height the transfer is pinned at, so the lock
    // that credited the escrow is at or below it. A checkpoint BELOW snapshot_block can
    // predate the lock entirely and would let a forged transfer be "proven" by an escrow
    // balance that was put there for some earlier transfer. At or after it, the credit is
    // inside the committed state.
    if(cpHeight < snapshot)
        return _fail(ESCROW_PROOF_REASON.CHECKPOINT_STALE);

    // The roots in the envelope must be the roots of the block the checkpoint commits, or
    // the reassembly below would compare roots from two different heights.
    const proofHeight = _height(proof.block_index);
    if(_str(proof.chain) !== srcChain || _str(proof.network) !== rowNet || proofHeight !== cpHeight)
        return _fail(ESCROW_PROOF_REASON.PROOF_BINDING);

    // The escrow address is resolved HERE from the origin chain's own config, never taken
    // from the envelope: an attacker who could name the address would simply prove the
    // balance of an address it had funded itself.
    const escrow = resolveEscrowAddress(srcChain, destChain, rowNet);
    if(!escrow)
        return _fail(ESCROW_PROOF_REASON.ESCROW_UNRESOLVED);
    if(_str(proof.address) !== escrow || _str(proof.tick) !== tick)
        return _fail(ESCROW_PROOF_REASON.PROOF_BINDING);

    const cpRoot = _str(cp.state_root);
    if(!cpRoot || !/^[0-9a-fA-F]{64}$/.test(cpRoot))
        return _fail(ESCROW_PROOF_REASON.CHECKPOINT_ROOTLESS);

    // The state_root layout is versioned: which named sub-trees really carry a root, and so
    // which leaf set the signed root commits, is a property of the version. A checkpoint cut
    // under a version this node does not derive here cannot be reassembled here, so it fails
    // CLOSED rather than being verified against the wrong layout.
    //
    // THE COMPARAND IS THE DERIVED VERSION, NEVER THE STATIC merkle.STATE_ROOT_VERSION. The
    // fleet mints this number per height, per chain and per network out of the sub-tree
    // activation maps (xchain-indexer/src/api.js getblockhashes, which is the ONLY place it
    // is minted; the hub's checkpoint engine copies it verbatim into the signed canonical and
    // from there into the anchor row). BTC:regtest derives 2 from block 10000 and all three
    // testnet chains derive 2 from genesis, so a static comparison against the merkle
    // constant (1) refuses every genuine checkpoint those chains have ever signed, which
    // would leave the bridge unable to mint anywhere the cross-check is armed. Deriving it
    // the same way the producer does keeps the real binding: a stamped version that
    // disagrees with this node's own maps at that height is a checkpoint whose committed
    // leaf set this node does not agree on, and it is refused.
    //
    // Derived at the CHECKPOINT'S OWN height (cpHeight), never at this chain's tip and never
    // at the transfer's snapshot_block: the version travels with the root it describes, and
    // tip derivation is the specific trap api.js calls out, because it relabels every
    // below-boundary checkpoint once a slot arms.
    const stampedVersion  = _version(cp.state_root_version);
    // srcChain and rowNet ARE the checkpoint's own chain and network: the binding check above
    // refused the row unless cp.chain and cp.network matched them exactly.
    const derivedVersion  = stateSubtree.stateRootVersion(cpHeight, rowNet, srcChain);
    if(stampedVersion === null || stampedVersion !== derivedVersion)
        return _fail(ESCROW_PROOF_REASON.ROOT_VERSION);

    const subRoots = proof.sub_roots;
    const balancesRoot = subRoots && _str(subRoots.balances_root);
    if(!subRoots || typeof subRoots !== 'object' || !balancesRoot || !/^[0-9a-fA-F]{64}$/.test(balancesRoot))
        return _fail(ESCROW_PROOF_REASON.PROOF_MALFORMED);

    // THE BINDING THAT MAKES THE WHOLE CHECK WORTH ANYTHING: the sub-roots handed over must
    // reassemble, byte for byte, to the state_root the checkpoint quorum signed. Without it
    // a forger supplies its own balances_root and proves whatever balance it likes under it.
    let assembled;
    try { assembled = M.toHex(M.stateRoot(subRoots)); }
    catch(e){ return _fail(ESCROW_PROOF_REASON.PROOF_MALFORMED); }
    if(assembled.toLowerCase() !== cpRoot.toLowerCase())
        return _fail(ESCROW_PROOF_REASON.ROOT_MISMATCH);

    // The claimed balance decides the leaf, so a claim and its proof cannot drift apart. The
    // envelope's own leaf_value is never read: it is the one field a forger would set to the
    // leaf it holds a proof for while claiming a different balance.
    const claimed = _scaled(proof.balance);
    if(claimed === null)
        return _fail(ESCROW_PROOF_REASON.PROOF_MALFORMED);
    // Delete-on-zero is normative for balances_root, so a zero balance is a NON-membership
    // proof (no leaf), not a leaf holding zero.
    let leaf = null;
    if(claimed > 0n){
        try { leaf = M.amountLeaf(String(proof.balance).trim()); }
        catch(e){ return _fail(ESCROW_PROOF_REASON.PROOF_MALFORMED); }
    }

    let key;
    try { key = M.balanceKey(srcChain, rowNet, escrow, tick); }
    catch(e){ return _fail(ESCROW_PROOF_REASON.PROOF_MALFORMED); }

    const bp = proof.balance_proof;
    if(!bp || typeof bp !== 'object')
        return _fail(ESCROW_PROOF_REASON.PROOF_MALFORMED);
    // The verifier compares its recomputed root as lowercase hex, so an envelope that spells
    // its roots in upper case must not read as a forgery. Normalize once, here.
    const rootLc = balancesRoot.toLowerCase();
    let verified;
    try {
        if(Array.isArray(bp.siblings) && !bp.bitmap)
            verified = M.verifySmtProof(rootLc, key, leaf, bp.siblings);
        else if(bp.compressed)
            verified = M.verifyCompressedSmtProof(rootLc, key, leaf, bp.compressed);
        else if(bp.bitmap)
            verified = M.verifyCompressedSmtProof(rootLc, key, leaf, bp);
        else
            return _fail(ESCROW_PROOF_REASON.PROOF_MALFORMED);
    } catch(e){
        // A malformed sibling list (wrong length, non-hex, surplus compressed siblings)
        // throws inside the verifier. It is a bad proof, not a crash of the block loop.
        return _fail(ESCROW_PROOF_REASON.PROOF_MALFORMED);
    }
    if(!verified)
        return _fail(ESCROW_PROOF_REASON.PROOF_INVALID);

    // The escrow must already hold at least what this transfer is about to mint. It is an
    // inequality and not an equality on purpose (D65): a stray credit to the escrow address
    // is a surplus and harms nobody, while a deficit is the direction in which somebody
    // else's units would have nothing behind them.
    if(claimed < amount)
        return _fail(ESCROW_PROOF_REASON.INSUFFICIENT);

    return _pass(ESCROW_PROOF_REASON.VERIFIED);
}

module.exports = {
    verifyEscrowAgainstCheckpoint,
    resolveEscrowAddress,
    ESCROW_PROOF_REASON,
    ESCROW_ROLE_PREFIX,
    ESCROW_CHAIN,
};
