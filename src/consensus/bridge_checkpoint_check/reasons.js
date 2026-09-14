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
 * XChain Platform - the escrow cross-check: its failure vocabulary, its two verdict
 * constructors and the escrow role constants.
 *
 * Pure data and pure constructors, so this part is required directly by the entry and by the
 * binding phases beside it.
 *
 ********************************************************************/

'use strict';

// Role prefix of the escrow address on the ORIGIN chain: one protocol address per
// destination chain, ADDRESS.BRIDGE_<DEST_COIN>. Unspendable because no
// key exists, which is what lets it be an ordinary balance rather than an escrow row.
const ESCROW_ROLE_PREFIX = 'BRIDGE_';

// The chain the escrow lives on for the XCHAIN tick. XCHAIN is minted on BTC and
// nowhere else, v0 locks are BTC only and v1 burns are non-BTC only, so the
// escrow addresses are roles in the BTC coin bundle and the leg follows from src_chain alone.
// The token bridge generalizes this to the tick's OWN origin chain; that generalization is
// that code's job, not this module's, and the constant is named here so it is a one-line change
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

function fail(reason){ return { ok: false, reason: reason }; }
function pass(reason){ return { ok: true,  reason: reason }; }

module.exports = { ESCROW_ROLE_PREFIX, ESCROW_CHAIN, ESCROW_PROOF_REASON, fail, pass };
