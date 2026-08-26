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
 * The validator_rewards ledger key's ROUND QUALIFIER.
 *
 * A reward row is identified by (source_id, signing_pubkey_id, reward_type,
 * round_reference, round_qualifier). The first four have always been there; the
 * qualifier exists because ONE reward type's round_reference is not a chain height.
 *
 * The per-chain anchor legs key on CHECKPOINT_SEQ, and
 * StateCheckpointEngine.deriveCheckpointSeq(snapshot_block) === snapshot_block, so their
 * round_reference is a chain value that only ever advances - it can never be reissued.
 * The ARCHIVE leg keys on MATCH_BATCH_SEQ, a DENSE counter the hub allocates from its own
 * tables, and those tables are reset by a wipe-and-replay rebase (the same property the
 * archive replay guard in actions/anchor.js reasons about). After a rebase the hub reissues
 * seq values earlier archive batches already used, so two genuinely distinct archive
 * anchors - different snapshot blocks, different quorum-attested publishes - can present
 * the same round_reference.
 *
 * The SIGNED side already tells them apart: the XANCPUB reward canonical carries
 * SNAPSHOT_BLOCK alongside MATCH_BATCH_SEQ, and anchor_reward_attestations' uq_reward_tuple
 * includes snapshot_block. Only the ledger key and the reconcile predicate used to drop it,
 * so the attestation layer knew there were two rewards while the ledger conserved one: the
 * pending-attestation NOT EXISTS suppressed the second derive outright, and where both rows
 * did land the MIN(pubkey) reconcile deleted one real publisher's pay.
 *
 * So the qualifier is snapshot_block for anchor_archive and 0 for every other reward type,
 * which keeps every non-archive row (oracle_*, attest_*, anchor_<CHAIN>, and the legacy
 * pre-flag-day hub pushes) byte-identical to what it was before the column existed.
 *
 * It lives in its own module because the SAME rule has to hold in three places that must
 * never drift: the DOGE-side parse writer (actions/anchor.js), the BTC-side derive writer
 * (anchor_reward_derive.js), and the SQL predicate that decides which attestations are still
 * pending (db.js getPendingAnchorRewardAttestations). Two of those are JavaScript and one is
 * SQL, so both forms are exported from here and read from the same constant.
 *
 ********************************************************************/

'use strict';

// The one reward type whose round_reference is a reissuable counter rather than a height.
const ARCHIVE_REWARD_TYPE = 'anchor_archive';

// The ledger-key qualifier for a reward of `rewardType` earned at `snapshotBlock`.
// Non-archive -> 0, always, so those keys are exactly what they were pre-column.
// A non-finite/negative snapshot block also yields 0 (the legacy value): the two writers
// both validate the height before this point (anchor.js regex-checks SNAPSHOT_BLOCK at
// parse, the derive path reads a BIGINT UNSIGNED column), so this is a fail-to-legacy
// floor, not a live path.
function rewardRoundQualifier(rewardType, snapshotBlock){
    if(String(rewardType) !== ARCHIVE_REWARD_TYPE) return 0;
    let sb = Number(snapshotBlock);
    return (Number.isFinite(sb) && sb >= 0) ? Math.floor(sb) : 0;
}

// The SQL twin of rewardRoundQualifier, for predicates that must compute the qualifier a
// row WOULD carry from an attestation row's own columns. Emitted from the same constant as
// the JS form, so the two cannot disagree about which reward type is qualified.
// `typeCol` / `snapshotCol` are caller-supplied column references (never user input).
function sqlRoundQualifier(typeCol, snapshotCol){
    return "CASE WHEN " + typeCol + " = '" + ARCHIVE_REWARD_TYPE + "'" +
           " THEN " + snapshotCol + " ELSE 0 END";
}

module.exports = { ARCHIVE_REWARD_TYPE, rewardRoundQualifier, sqlRoundQualifier };
