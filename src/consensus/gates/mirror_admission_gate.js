'use strict';

const { create: createBounds } = require('./mirror_admission/bounds');
const { create: createActivation } = require('./mirror_admission/activation');
const { create: createCanonical } = require('./mirror_admission/canonical');
const { create: createAdmitBlocks } = require('./mirror_admission/admit_blocks');

const bounds = createBounds();
const activation = createActivation(bounds);
const canonical = createCanonical(activation);
const admitBlocks = createAdmitBlocks();

/*
 * mirror_admission_gate.js - admission by height for the mirror barrier family.
 *
 * BYTE-IDENTICAL TWIN. The canonical copy is xchain-indexer/src/; xchain-hub/src/ and
 * xchain-explorer/src/ carry it byte for byte, so edit the indexer copy and copy it outward.
 * reconcile-twins.sh --check grades both pairs. The explorer pair is also held by
 * xchain-indexer/bin/sync-hub-mirror-client.sh --check (a cmp -s byte compare, not a digest),
 * which never reads the hub copy; the hub pair is also held by the byte compare in the
 * activation-constants parity suite, which skips without a sibling checkout unless
 * XCHAIN_REQUIRE_SIBLINGS=1. That suite also holds the exported constants value-identical to
 * xchain-documentation/protocol/constants.js. A one-sided edit forks consensus at the boundary.
 *
 * ONE REQUIRE, DELIBERATELY. This module is a DEP_FILES entry of sync-hub-mirror-client.sh: it
 * is vendored into the explorer beside hub_db_sync.js, which can carry no dependency the
 * explorer does not have, so it requires only ../gate_registry, which every consumer carries
 * as its own. price_batching_floor_gate.js is the precedent. The alternative considered and
 * rejected was threading an admission bound through eleven predicate signatures, their
 * waiters and every call site.
 *
 * WHAT THIS IS FOR
 *
 * Eleven barrier hold points in the indexer block loop key on the block's own protocol
 * timestamp t(B). Bitcoin consensus accepts a block stamped up to 7200 s ahead of
 * network-adjusted time, so a VALID block holds a hub-connected indexer's whole block loop
 * for that distance plus the member's grace, while /status reports the deliberately healthy
 * 'future_block_wait' verdict for the entire stall.
 *
 * No grace can fix this. A mirrored row binds at B when its signed effective_time <= t(B),
 * and a producer may mint such a row at any wall-clock instant up to t(B) - RELAY_MIN_FUTURE_S,
 * so the SET of rows binding at B is not determined until wall clock reaches that instant.
 * Any correct barrier under that binding rule must wait for it, whatever its grace.
 *
 * So the binding rule changes. Every mirrored row carries a signed ADMISSION HEIGHT per chain
 * that reads it; a row is readable at B on chain C only when admit_blocks[C] <= B; and each
 * barrier certifies completeness by comparing a per-table per-chain HEIGHT watermark against B
 * rather than a clock against t(B). Heights do not move with stamps, so a block stamped 7200 s
 * ahead is height B like any other.
 */
/*
 * Layout: mirror_admission/activation.js holds the activation maps and predicates,
 * bounds.js the margins and height comparisons, canonical.js the signed encoding, and
 * admit_blocks.js the stored-column reader. This file only re-exports them.
 */

module.exports = {
    ADMIT_MARGIN_BLOCKS: bounds.ADMIT_MARGIN_BLOCKS,
    ADMIT_MIN_FUTURE_BLOCKS: bounds.ADMIT_MIN_FUTURE_BLOCKS,
    ADMIT_MAX_FUTURE_BLOCKS: bounds.ADMIT_MAX_FUTURE_BLOCKS,
    MIRROR_ADMISSION_ACTIVATION: activation.MIRROR_ADMISSION_ACTIVATION,
    MIRROR_ADMISSION_CONSUMER_ACTIVATION: activation.MIRROR_ADMISSION_CONSUMER_ACTIVATION,
    MIRROR_ADMISSION_REGTEST_ENV: activation.MIRROR_ADMISSION_REGTEST_ENV,
    MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT: activation.MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT,
    resolveMirrorAdmissionRegtest: activation.resolveMirrorAdmissionRegtest,
    admissionKey: activation.admissionKey,
    isMirrorAdmissionProducerActive: activation.isMirrorAdmissionProducerActive,
    isMirrorAdmissionConsumerActive: activation.isMirrorAdmissionConsumerActive,
    admitMarginBlocks: bounds.admitMarginBlocks,
    admitMaxFutureBlocks: bounds.admitMaxFutureBlocks,
    isAdmitBlockInFollowerBound: bounds.isAdmitBlockInFollowerBound,
    isRowReadableAt: bounds.isRowReadableAt,
    CHAIN_CODE_RE: canonical.CHAIN_CODE_RE,
    CANONICAL_HEIGHT_RE: canonical.CANONICAL_HEIGHT_RE,
    encodeAdmitBlocks: canonical.encodeAdmitBlocks,
    decodeAdmitBlocks: canonical.decodeAdmitBlocks,
    isAdmissionEra: canonical.isAdmissionEra,
    admissionCanonicalField: canonical.admissionCanonicalField,
    admissionCanonicalValue: canonical.admissionCanonicalValue,
    ADMIT_COLUMN_CHAINS: admitBlocks.ADMIT_COLUMN_CHAINS,
    columnsAdmitBlocks: admitBlocks.columnsAdmitBlocks,
};
