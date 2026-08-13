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
 * Per-subcommand root discriminator for the ATTEST request_id / XCALL call_id
 * preimages.
 *
 * Both preimages carry a per-root discriminator, threaded to the VM as
 * `rootActionIndex` and re-derived host-side from ROOT_ACTION_INDEX. Its value is
 * the root action's on-chain output index TX_VOUT, chosen because TX_VOUT is
 * reorg-stable and was assumed distinct per root action within one transaction.
 *
 * A BATCH breaks that assumption. actions.js assigns TX_VOUT once per TRANSACTION,
 * and every subcommand of a BATCH is its own root action underneath it, each
 * seeding call-path ''. Two EXECUTE subcommands against the SAME contract in one
 * BATCH therefore produced the IDENTICAL request_id for their first attestation:
 * db.createAttestationRequest saw the prior row, warned and returned without
 * inserting, and the second execution ran bound to the FIRST request's provider,
 * payload and callback while its own value stayed escrowed against no row.
 *
 * The fix is this composite: a root action that IS a BATCH subcommand carries
 *
 *     "<TX_VOUT>.<subcommand position>"
 *
 * where the position is the 0-based index of the subcommand in the BATCH's command
 * list (content-derived: it comes from the transaction's own data, so it is
 * byte-stable across nodes and reorgs, unlike action_index, which advances with
 * synthetic-action injection timing and forked the PBFT). Every other root keeps
 * the bare TX_VOUT it has always used.
 *
 * '.' appears in no other preimage field and the field separator is ':', so the
 * composite stays one unambiguous token. The VM keeps it intact rather than folding
 * it through Number(), which would collapse '3.10' and '3.1' onto the same value
 * (xchain-vm/src/gateway-emit.js normalizeRootDiscriminator).
 *
 * FLAG-DAY GATED. The request_id is a consensus preimage (it is what the ATTEST v0
 * handler re-derives to accept a request, what validators sign over, and what the
 * callback resolves against), and mainnet carries live history, so below the flag
 * day the bare TX_VOUT must be reproduced verbatim. The gate is
 * BATCH_SUBCOMMAND_ROOT_DISCRIMINATOR in protocol_changes.js: genesis on
 * testnet/regtest, UNARMED on mainnet until the operator dates it.
 *
 ********************************************************************/

// Protocol-change name every caller must gate on. Named once here so the four call
// sites (execute.js root/guard/emission, deploy.js constructor) cannot drift onto
// different gates, which would derive different ids for the same emission.
const BATCH_ROOT_DISCRIMINATOR_GATE = 'BATCH_SUBCOMMAND_ROOT_DISCRIMINATOR';

/**
 * Build the per-root discriminator for a root action.
 *
 * @param {*}       txVout        The root action's on-chain output index (TX_VOUT).
 * @param {*}       batchPosition 0-based position of this action within its BATCH's
 *                                command list, or null/undefined when the action is
 *                                not a BATCH subcommand.
 * @param {boolean} gateActive    BATCH_SUBCOMMAND_ROOT_DISCRIMINATOR activation for
 *                                the block being processed.
 * @returns {*} TX_VOUT unchanged (every pre-flag-day case, and every non-BATCH root),
 *              or the composite "<TX_VOUT>.<position>" string.
 */
function rootDiscriminator(txVout, batchPosition, gateActive){
    // Preserve the historical fallback exactly: a missing TX_VOUT hashed as 0.
    let base = (txVout != null) ? txVout : 0;
    if(!gateActive)
        return base;
    // Not a BATCH subcommand: the bare TX_VOUT already names this root uniquely.
    if(batchPosition === undefined || batchPosition === null)
        return base;
    return String(base) + '.' + String(batchPosition);
}

/**
 * rootDiscriminator with the flag-day lookup folded in, which is the form every
 * consensus call site uses.
 *
 * The gate is consulted ONLY for an action that actually is a BATCH subcommand:
 * for anything else the discriminator is the bare TX_VOUT on both sides of the flag
 * day, so the activation lookup could not change the answer. That keeps the block
 * loop's hot path (one call per emission) free of an extra activation read per
 * emission while leaving the derived value identical either way.
 *
 * @param {object} protocolChanges The ProtocolChanges instance (isEnabled).
 * @param {*}      blockIndex      Block being processed (activation plane).
 * @param {*}      txVout          The root action's on-chain output index.
 * @param {*}      batchPosition   0-based BATCH position, or null when not a subcommand.
 * @returns {Promise<*>} the discriminator to hash.
 */
async function resolveRootDiscriminator(protocolChanges, blockIndex, txVout, batchPosition){
    if(batchPosition === undefined || batchPosition === null)
        return rootDiscriminator(txVout, null, false);
    let active = await protocolChanges.isEnabled(BATCH_ROOT_DISCRIMINATOR_GATE, blockIndex);
    return rootDiscriminator(txVout, batchPosition, active);
}

module.exports = { BATCH_ROOT_DISCRIMINATOR_GATE, rootDiscriminator, resolveRootDiscriminator };
