/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Stake-weight snapshot binary-collation flag-day.
 *
 * WHAT IS ACTUALLY WRONG. db._cappedStakeWeightsSql ranks, partitions and
 * orders the stake-weight snapshot on the unqualified `source` column, which
 * resolves through index_addresses.address (declared CHARSET=utf8
 * COLLATE=utf8_general_ci, i.e. case- AND accent-folding), and on `pubkey`
 * from index_pubkeys.pubkey under the same collation. Every other
 * consensus-facing read of those columns pins a binary collation - see the
 * `a1.address COLLATE utf8_bin` sites in db.getBlockHashes / getList and
 * stateHash.js - and this one does not.
 *
 * It is NOT the case that two folding-equal sources collapse into one
 * DENSE_RANK bucket: index_addresses carries a FULL-COLUMN UNIQUE index on
 * `address` under that same folding collation, so two collation-equal
 * addresses cannot coexist in the table at all (a case-variant INSERT is
 * rejected with errno 1062). That mechanism is structurally blocked, and any
 * fix justified by it would be fixing nothing.
 *
 * What survives is the ORDER, and here the order is a consensus quantity. The
 * window caps truncate: `_sr <= STAKE_WEIGHT_MAX_SOURCES` decides WHICH
 * staking sources survive the snapshot, and `_kr <=
 * STAKE_WEIGHT_MAX_KEYS_PER_SOURCE` decides WHICH keys of a source survive.
 * The surviving SET feeds stateCommitment.gatherStakeEntries and therefore the
 * committed stakes_root. Binary and folding order genuinely differ ('a' sorts
 * BEFORE 'B' under utf8_general_ci and AFTER it under utf8_bin), so two nodes
 * that disagree about the collation of these columns select different
 * survivors at the cap and commit different roots. The live divergence vector
 * is not exotic addresses, it is SCHEMA DRIFT: a node whose column collation
 * deviates from src/sql sorts differently, and nothing today notices.
 *
 * WHY GATED. Pinning the collation CHANGES the order, so it changes which rows
 * survive the cap, so it can change how an already-valid block evaluates. An
 * ungated flip forks against deployed nodes. Below the height the SQL is
 * emitted byte-identically to what shipped before this gate existed.
 *
 * WHY BOTH REPOS MOVE TOGETHER. `_cappedStakeWeightsSql` is byte-mirrored in
 * xchain-sync/src/db.js and the follower rebuilds the same stakes_root from
 * it. Pinning the collation on ONE side IS the fork this gate exists to
 * prevent, which is why this file is a byte-identical twin in both repos and
 * is listed in the cross-repo twin guard
 * (xchain-sync/test/unit/rollback-coverage.test.js). BOTH fleets must deploy
 * before any height is armed.
 *
 * The schema expectations the startup check enforces live here too, rather
 * than in each repo's db.js, for the same reason: one definition, twinned, so
 * the two services cannot disagree about what "undrifted" means.
 *
 ********************************************************************/

// The collation the consensus ordering is pinned to once the rule is live.
// FROZEN: this string is the emitted SQL of a consensus query, so changing it
// after any chain arms re-orders the cap survivors on a replay, which is a
// fork. utf8_bin is the collation the sibling consensus reads already pin, and
// it is charset-compatible with the utf8/utf8mb3 columns involved.
const STAKE_WEIGHT_COLLATION = 'utf8_bin';

// Per-chain activation heights, interpreted against the chain's own block_index.
// `null` = NOT YET PINNED = inert (legacy unpinned ordering, byte-identical
// replay). Only regtest is armed, so fresh regtest stacks and the e2e
// conformance scenario exercise the binary path end to end. Mainnet and testnet
// heights are pinned at flag-day assembly, above the tip recorded at that time,
// in ONE coordinated deploy of BOTH fleets: a height a carrying fleet has
// already passed arms retroactively, and a height armed while one fleet is
// behind halts the follower.
const STAKE_WEIGHT_COLLATION_ACTIVATION = {
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  null,
    'LTC:testnet':  null,
    'DOGE:testnet': null,
    regtest: 0,
};

// Per-chain threshold with a network-wide fallback, byte-for-byte the lookup
// state_key_collation_activation.js uses. A coin-less caller (unit fixtures,
// and xchain-sync when it has no per-chain context) falls through to the bare
// network key and stays inert on mainnet/testnet, which is the safe side.
function _activationThreshold(network, coin){
    if(coin != null && STAKE_WEIGHT_COLLATION_ACTIVATION[coin + ':' + network] !== undefined)
        return STAKE_WEIGHT_COLLATION_ACTIVATION[coin + ':' + network];
    return STAKE_WEIGHT_COLLATION_ACTIVATION[network];
}

// Whether the stake-weight snapshot orders under the binary collation at
// `blockIndex` on `network` for `coin`. An unpinned chain, an unknown network,
// or an unparseable/absent block index -> off, i.e. the legacy ordering.
function isStakeWeightBinCollationActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    if(threshold === undefined || threshold === null) return false;
    return b >= threshold;
}

// The COLLATE suffix to splice after each ordered column, or '' below the
// height. Returning a suffix rather than a whole clause keeps the legacy SQL
// byte-identical: below the height every emission site concatenates ''.
function stakeWeightCollate(active){
    return active ? ' COLLATE ' + STAKE_WEIGHT_COLLATION : '';
}

// ---------------------------------------------------------------------------
// Schema-drift contract for the columns the ordering above reads.
//
// The pin is only worth what the underlying charset is: on a node whose
// index_addresses.address drifted to utf8mb4, `COLLATE utf8_bin` is not a
// different sort order, it is errno 1253 ("COLLATION 'utf8mb3_bin' is not
// valid for CHARACTER SET 'utf8mb4'") and the node dies mid-block at the armed
// height instead of at boot. Hence the fail-closed startup check.
//
// NAMES ARE NOT COMPARABLE AS WRITTEN. MariaDB 10.6 renamed the utf8 charset
// to utf8mb3, so a column DECLARED `CHARSET=utf8 COLLATE=utf8_general_ci`
// reports CHARACTER_SET_NAME='utf8mb3' / COLLATION_NAME='utf8mb3_general_ci'
// in information_schema (verified on 11.4.12). A check comparing the reported
// name to the declared one literally would halt every node in the fleet on a
// perfectly correct schema, so both sides are normalised through the alias
// below before comparing.
// ---------------------------------------------------------------------------

// Columns whose charset/collation the consensus ordering depends on, and the
// charset/collation src/sql declares for each.
const STAKE_WEIGHT_ORDERING_COLUMNS = [
    { table: 'index_addresses', column: 'address', charset: 'utf8', collation: 'utf8_general_ci' },
    { table: 'index_pubkeys',   column: 'pubkey',  charset: 'utf8', collation: 'utf8_general_ci' },
];

// Fold the utf8 / utf8mb3 spelling of a charset or collation name onto one
// token so a correct schema on any server version compares equal.
function normalizeCollationName(name){
    if(name == null) return null;
    return String(name).toLowerCase().replace(/^utf8mb3(_|$)/, 'utf8$1');
}

// Reason string when a live column has drifted off the declared contract, or
// null when it matches. `row` is one information_schema.columns row carrying
// CHARACTER_SET_NAME / COLLATION_NAME (either case). An ABSENT column returns
// null: the table may not exist yet on a fresh install, and a missing table is
// the schema layer's problem, not this check's - the same convention
// _assertPubkeyColumnIsUncompressedWide follows. An unreadable (NULL) name
// likewise returns null rather than halting a node on an answer we could not
// read.
function collationDriftReason(spec, row){
    if(!row) return null;
    let charset   = normalizeCollationName(row.CHARACTER_SET_NAME != null ? row.CHARACTER_SET_NAME : row.character_set_name);
    let collation = normalizeCollationName(row.COLLATION_NAME    != null ? row.COLLATION_NAME    : row.collation_name);
    if(charset == null || collation == null) return null;
    let wantCharset   = normalizeCollationName(spec.charset);
    let wantCollation = normalizeCollationName(spec.collation);
    if(charset === wantCharset && collation === wantCollation) return null;
    return spec.table + '.' + spec.column + ' is ' + charset + ' / ' + collation +
           ' but src/sql declares ' + wantCharset + ' / ' + wantCollation + '. The stake-weight ' +
           'snapshot orders on this column and the ORDER decides which sources and keys survive ' +
           'the cap, so a drifted collation commits a different stakes_root than the rest of the ' +
           'fleet; once STAKE_WEIGHT_COLLATION_ACTIVATION is armed a drifted CHARSET fails the ' +
           'query outright (errno 1253). Restore the declared charset/collation on this column ' +
           'before running this node.';
}

module.exports = {
    STAKE_WEIGHT_COLLATION,
    STAKE_WEIGHT_COLLATION_ACTIVATION,
    STAKE_WEIGHT_ORDERING_COLUMNS,
    isStakeWeightBinCollationActive,
    stakeWeightCollate,
    normalizeCollationName,
    collationDriftReason
};
