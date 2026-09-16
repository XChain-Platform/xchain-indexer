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
 * XChain Platform - the escrow cross-check: the chain of bindings, one phase per link.
 *
 * The entry's header lists the seven bindings a forgery has to break, and the phases here are
 * those links in that order: the leg, the checkpoint's identity and staleness, the envelope's
 * binding to this transfer and this escrow address, the derived root version, the reassembly
 * to the signed state_root, and the proven balance against the amount. A phase returns a
 * VERDICT to stop the check where the original stopped it, or the values the next link needs.
 * Synchronous and pure throughout, which is the property that keeps two nodes from disagreeing
 * because one of them had a slower database.
 *
 ********************************************************************/

'use strict';

const M = require('../merkle.js');
// The state_root layout version is a DERIVED quantity, per height, chain and network. This
// is the same module the block path and getblockhashes derive it from, so this check and the
// value the fleet stamps into the signed checkpoint cannot come apart.
const stateSubtree = require('../../state_subtree_activation.js');
const { ESCROW_CHAIN, ESCROW_PROOF_REASON, fail, pass } = require('./reasons.js');
const { str, height, version, scaled } = require('./fields.js');
const { resolveEscrowAddress } = require('./escrow_address.js');

/**
 * Link 1: is this leg one this check judges at all, and does the row carry what the check
 * needs? An OUT leg is a PASS here rather than a refusal, so this phase can answer with a
 * finished verdict as well as with a refusal.
 *
 * @returns {{verdict: Object}|{fields: Object}}
 */
function screenLeg(row, ctx){
    if(!row || typeof row !== 'object' || !ctx || typeof ctx !== 'object')
        return { verdict: fail(ESCROW_PROOF_REASON.ROW_FIELDS) };

    const srcChain  = str(row.src_chain);
    const destChain = str(row.dest_chain);
    const rowNet    = str(row.network);
    const tick      = str(row.tick);
    const snapshot  = height(row.snapshot_block);
    const thisChain = str(ctx.coin);
    const ctxNet    = str(ctx.network);
    if(!srcChain || !destChain || !rowNet || !tick || snapshot === null || !thisChain || !ctxNet)
        return { verdict: fail(ESCROW_PROOF_REASON.ROW_FIELDS) };
    if(srcChain === destChain)
        return { verdict: fail(ESCROW_PROOF_REASON.ROW_FIELDS) };

    // The transfer must be for the network this indexer is on. A foreign-network row is
    // refused outright by the settle pass too; it is re-checked here because every key and
    // every root below is network-scoped, so proceeding on a mismatch would prove a balance
    // on a chain this node is not indexing.
    if(rowNet !== ctxNet)
        return { verdict: fail(ESCROW_PROOF_REASON.ROW_NETWORK) };

    // The settle pass applies THIS chain's leg, and that is always the destination leg: an
    // in leg mints here from a lock on the escrow chain, an out leg releases escrow here
    // from a burn on the other side. A row naming neither side as this chain is not ours.
    if(thisChain !== destChain) return { verdict: fail(ESCROW_PROOF_REASON.NOT_THIS_CHAIN) };

    // Direction is DERIVED and is never a column. The OUT leg releases an escrow that
    // is an ordinary balance on this very chain, where the local ledger is authoritative and
    // the would-go-negative refusal in the settle pass is the guard: a remote checkpoint can
    // add nothing to a balance this node holds itself.
    if(thisChain === ESCROW_CHAIN) return { verdict: pass(ESCROW_PROOF_REASON.OUT_LEG) };

    // Everything else is an IN leg: this chain is about to MINT, so it needs the proof. The
    // exemption is keyed on THIS chain being the escrow chain and never on the row's
    // src_chain, and that ordering is the whole point. Read the other way round, a forged row
    // naming any non-escrow source chain would derive as an "out leg" and mint here with no
    // cross-check at all, which is precisely the forgery this cross-check exists to stop. A mint can only
    // come from a lock on the escrow chain, so a source chain that is not it is refused.
    if(srcChain !== ESCROW_CHAIN) return { verdict: fail(ESCROW_PROOF_REASON.IN_LEG_ORIGIN) };

    const amount = scaled(row.amount);
    if(amount === null || amount <= 0n)
        return { verdict: fail(ESCROW_PROOF_REASON.ROW_AMOUNT) };

    return { fields: { srcChain, destChain, rowNet, tick, snapshot, amount } };
}

/**
 * Link 2: the checkpoint is present, is the ORIGIN chain's on this network, and is not stale.
 *
 * @returns {{verdict: Object}|{cp: Object, cpHeight: number}}
 */
function bindCheckpoint(proof, f){
    if(!proof || typeof proof !== 'object')
        return { verdict: fail(ESCROW_PROOF_REASON.PROOF_MISSING) };

    const cp = proof.checkpoint;
    if(!cp || typeof cp !== 'object')
        return { verdict: fail(ESCROW_PROOF_REASON.CHECKPOINT_MISSING) };

    // The checkpoint must be the ORIGIN chain's, on this network. A checkpoint of the
    // destination chain proves nothing about the escrow, and one of another network proves
    // a balance in another ledger entirely.
    if(str(cp.chain) !== f.srcChain || str(cp.network) !== f.rowNet)
        return { verdict: fail(ESCROW_PROOF_REASON.CHECKPOINT_BINDING) };

    const cpHeight = height(cp.block_index);
    if(cpHeight === null)
        return { verdict: fail(ESCROW_PROOF_REASON.CHECKPOINT_BINDING) };

    // STALENESS. snapshot_block is the origin height the transfer is pinned at, so the lock
    // that credited the escrow is at or below it. A checkpoint BELOW snapshot_block can
    // predate the lock entirely and would let a forged transfer be "proven" by an escrow
    // balance that was put there for some earlier transfer. At or after it, the credit is
    // inside the committed state.
    if(cpHeight < f.snapshot)
        return { verdict: fail(ESCROW_PROOF_REASON.CHECKPOINT_STALE) };

    return { cp: cp, cpHeight: cpHeight };
}

/**
 * Link 3: the envelope is the one this transfer and this escrow address are about, at the
 * checkpoint's own height.
 *
 * @returns {{verdict: Object}|{escrow: string}}
 */
function bindEnvelope(proof, f, cpHeight){
    // The roots in the envelope must be the roots of the block the checkpoint commits, or
    // the reassembly below would compare roots from two different heights.
    const proofHeight = height(proof.block_index);
    if(str(proof.chain) !== f.srcChain || str(proof.network) !== f.rowNet || proofHeight !== cpHeight)
        return { verdict: fail(ESCROW_PROOF_REASON.PROOF_BINDING) };

    // The escrow address is resolved HERE from the origin chain's own config, never taken
    // from the envelope: an attacker who could name the address would simply prove the
    // balance of an address it had funded itself.
    const escrow = resolveEscrowAddress(f.srcChain, f.destChain, f.rowNet);
    if(!escrow)
        return { verdict: fail(ESCROW_PROOF_REASON.ESCROW_UNRESOLVED) };
    if(str(proof.address) !== escrow || str(proof.tick) !== f.tick)
        return { verdict: fail(ESCROW_PROOF_REASON.PROOF_BINDING) };

    return { escrow: escrow };
}

/**
 * Link 4: the signed root exists and was cut under the layout version THIS node derives at
 * the checkpoint's own height.
 *
 * The state_root layout is versioned: which named sub-trees really carry a root, and so
 * which leaf set the signed root commits, is a property of the version. A checkpoint cut
 * under a version this node does not derive here cannot be reassembled here, so it fails
 * CLOSED rather than being verified against the wrong layout.
 *
 * THE COMPARAND IS THE DERIVED VERSION, NEVER THE STATIC merkle.STATE_ROOT_VERSION. The
 * fleet mints this number per height, per chain and per network out of the sub-tree
 * activation maps (xchain-indexer/src/api.js getblockhashes, which is the ONLY place it
 * is minted; the hub's checkpoint engine copies it verbatim into the signed canonical and
 * from there into the anchor row). BTC:regtest derives 2 from block 10000 and all three
 * testnet chains derive 2 from genesis, so a static comparison against the merkle
 * constant (1) refuses every genuine checkpoint those chains have ever signed, which
 * would leave the bridge unable to mint anywhere the cross-check is armed. Deriving it
 * the same way the producer does keeps the real binding: a stamped version that
 * disagrees with this node's own maps at that height is a checkpoint whose committed
 * leaf set this node does not agree on, and it is refused.
 *
 * Derived at the CHECKPOINT'S OWN height (cpHeight), never at this chain's tip and never
 * at the transfer's snapshot_block: the version travels with the root it describes, and
 * tip derivation is the specific trap api.js calls out, because it relabels every
 * below-boundary checkpoint once a slot arms.
 *
 * @returns {{verdict: Object}|{cpRoot: string}}
 */
function bindRootVersion(cp, f, cpHeight){
    const cpRoot = str(cp.state_root);
    if(!cpRoot || !/^[0-9a-fA-F]{64}$/.test(cpRoot))
        return { verdict: fail(ESCROW_PROOF_REASON.CHECKPOINT_ROOTLESS) };

    const stampedVersion  = version(cp.state_root_version);
    // srcChain and rowNet ARE the checkpoint's own chain and network: the binding check above
    // refused the row unless cp.chain and cp.network matched them exactly.
    const derivedVersion  = stateSubtree.stateRootVersion(cpHeight, f.rowNet, f.srcChain);
    if(stampedVersion === null || stampedVersion !== derivedVersion)
        return { verdict: fail(ESCROW_PROOF_REASON.ROOT_VERSION) };

    return { cpRoot: cpRoot };
}

/**
 * Link 5: THE BINDING THAT MAKES THE WHOLE CHECK WORTH ANYTHING: the sub-roots handed over must
 * reassemble, byte for byte, to the state_root the checkpoint quorum signed. Without it
 * a forger supplies its own balances_root and proves whatever balance it likes under it.
 *
 * @returns {{verdict: Object}|{balancesRoot: string}}
 */
function reassembleStateRoot(proof, cpRoot){
    const subRoots = proof.sub_roots;
    const balancesRoot = subRoots && str(subRoots.balances_root);
    if(!subRoots || typeof subRoots !== 'object' || !balancesRoot || !/^[0-9a-fA-F]{64}$/.test(balancesRoot))
        return { verdict: fail(ESCROW_PROOF_REASON.PROOF_MALFORMED) };

    let assembled;
    try { assembled = M.toHex(M.stateRoot(subRoots)); }
    catch(e){ return { verdict: fail(ESCROW_PROOF_REASON.PROOF_MALFORMED) }; }
    if(assembled.toLowerCase() !== cpRoot.toLowerCase())
        return { verdict: fail(ESCROW_PROOF_REASON.ROOT_MISMATCH) };

    return { balancesRoot: balancesRoot };
}

/**
 * Link 6: the claimed balance decides the leaf, so a claim and its proof cannot drift apart. The
 * envelope's own leaf_value is never read: it is the one field a forger would set to the
 * leaf it holds a proof for while claiming a different balance.
 *
 * @returns {{verdict: Object}|{claimed: BigInt, leaf: *, key: *}}
 */
function deriveClaimedLeaf(proof, f, escrow){
    const claimed = scaled(proof.balance);
    if(claimed === null)
        return { verdict: fail(ESCROW_PROOF_REASON.PROOF_MALFORMED) };
    // Delete-on-zero is normative for balances_root, so a zero balance is a NON-membership
    // proof (no leaf), not a leaf holding zero.
    let leaf = null;
    if(claimed > 0n){
        try { leaf = M.amountLeaf(String(proof.balance).trim()); }
        catch(e){ return { verdict: fail(ESCROW_PROOF_REASON.PROOF_MALFORMED) }; }
    }

    let key;
    try { key = M.balanceKey(f.srcChain, f.rowNet, escrow, f.tick); }
    catch(e){ return { verdict: fail(ESCROW_PROOF_REASON.PROOF_MALFORMED) }; }

    return { claimed: claimed, leaf: leaf, key: key };
}

/**
 * Link 7: the balance proof verifies under balances_root, and the proven balance covers the
 * amount about to be minted.
 *
 * @returns {Object} the finished verdict
 */
function verifyProvenBalance(proof, f, balancesRoot, claim){
    const bp = proof.balance_proof;
    if(!bp || typeof bp !== 'object')
        return fail(ESCROW_PROOF_REASON.PROOF_MALFORMED);
    // The verifier compares its recomputed root as lowercase hex, so an envelope that spells
    // its roots in upper case must not read as a forgery. Normalize once, here.
    const rootLc = balancesRoot.toLowerCase();
    let verified;
    try {
        if(Array.isArray(bp.siblings) && !bp.bitmap)
            verified = M.verifySmtProof(rootLc, claim.key, claim.leaf, bp.siblings);
        else if(bp.compressed)
            verified = M.verifyCompressedSmtProof(rootLc, claim.key, claim.leaf, bp.compressed);
        else if(bp.bitmap)
            verified = M.verifyCompressedSmtProof(rootLc, claim.key, claim.leaf, bp);
        else
            return fail(ESCROW_PROOF_REASON.PROOF_MALFORMED);
    } catch(e){
        // A malformed sibling list (wrong length, non-hex, surplus compressed siblings)
        // throws inside the verifier. It is a bad proof, not a crash of the block loop.
        return fail(ESCROW_PROOF_REASON.PROOF_MALFORMED);
    }
    if(!verified)
        return fail(ESCROW_PROOF_REASON.PROOF_INVALID);

    // The escrow must already hold at least what this transfer is about to mint. It is an
    // inequality and not an equality on purpose: a stray credit to the escrow address
    // is a surplus and harms nobody, while a deficit is the direction in which somebody
    // else's units would have nothing behind them.
    if(claim.claimed < f.amount)
        return fail(ESCROW_PROOF_REASON.INSUFFICIENT);

    return pass(ESCROW_PROOF_REASON.VERIFIED);
}

module.exports = {
    screenLeg,
    bindCheckpoint,
    bindEnvelope,
    bindRootVersion,
    reassembleStateRoot,
    deriveClaimedLeaf,
    verifyProvenBalance,
};
