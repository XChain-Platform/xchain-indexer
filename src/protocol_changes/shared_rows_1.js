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
 * The SHARED block, part 1 of 5: anchor_reward_activation to attest_responsible_widening_activation
 *
 * One SHARED block part. The region between the two marker lines is
 * BYTE-TWINNED into the registry of xchain-sync, xchain-hub, xchain-explorer
 * and xchain-sdk: each consumer keeps the same bytes and replaces only the
 * require line below with its own queue module. What may live between the
 * markers: `addGate(key, unit, table)` calls with LITERAL values (a table, a
 * number, a string or literals joined by +, a RegExp, an array), one call per
 * row, at column zero, and comments. No require, no computed value, nothing
 * from outside the block but addGate, UNARMED and UNPINNED. A regtest entry a
 * venue arms from its environment is written UNPINNED here and armed by the
 * wrapper at registration (shared_rows.js), so the block stays data.
 *
 * Rows are grouped by module stem in alphabetical order; a stem's rows keep
 * the order the module declared them. Keys never change (I4).
 *
 ********************************************************************/

'use strict';

const { addGate, UNARMED, UNPINNED } = require('./shared_rows.js');

// SHARED-GATES BEGIN
// anchor_reward_activation
// Per-network activation height, interpreted as the BTC-anchored snapshot_block
// carried by the ANCHOR canonical (NOT the local processing height), so every chain
// + the hub flip the reward-derivation path on the same anchor.
addGate('anchor_reward_activation.ANCHOR_REWARD_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers before this height
    testnet: 0,
    regtest: 0,
});

// The frozen validator anchor-publish reward. This is a CONSENSUS CONSTANT: the hub
// signs it into the XANCPUB attestation and the indexer re-derives it, never from
// the wire. Changing it is itself a flag-day. Kept equal to the hub's historical
// default (ANCHOR_REWARD_PER_PUBLISH = '10.00000000').
addGate('anchor_reward_activation.ANCHOR_REWARD_AMOUNT', 'constant', '10.00000000');

// Archive-reward re-derivation flag-day. Same shape as ANCHOR_REWARD_ACTIVATION,
// gating the ARCHIVE leg: at/above this BTC-anchored snapshot_block the elected
// archive leader emits a publisher-bearing archive head (v1 since the version
// restart, which always carries the PUBLISHER|ATTEST_SIG_COUNT|... tail; the
// retired v6 was that tail bolted onto a tail-less v1), attested
// over an 'anchor_archive' XANCPUB canonical) and the indexer derives the
// anchor_archive reward from those bytes; the key-authenticated
// pushvalidatorrewards rail is rejected for anchor_archive, closing the
// insider-with-key forge surface the per-chain flag-day left open. Below the
// threshold the legacy tail-less archive wire and the push path stand, and a
// publisher-bearing archive head is rejected.
addGate('anchor_reward_activation.ARCHIVE_REWARD_ACTIVATION', 'height', {
    mainnet: 963000,      // ARMED 2026-07-16, RE-PINNED 2026-08-12 off block 969500 onto the mainnet pre-freeze deploy-train boundary (tip 959,853 on 07-27 at ~144 blocks/day + 21d); deploy every consumer before this height
    testnet: 0,
    regtest: 0,
});

// The frozen archive-publish reward, signed into the archive XANCPUB attestation and
// re-derived by the indexer, never from the wire. Kept equal to the hub's historical
// default (ANCHOR_REWARD_PER_PUBLISH = '10.00000000'). Changing it is itself a flag-day.
addGate('anchor_reward_activation.ARCHIVE_REWARD_AMOUNT', 'constant', '10.00000000');

// ANCHOR_REWARD_DERIVE_ACTIVATION (Option C: derive on the BTC side).
// Relocates anchor-reward derivation from the DOGE indexer to the BTC indexer.
// ANCHOR is DOGE-only, but capability staking (the stake source
// createValidatorReward needs) is BTC-only, so DOGE-side derivation silently
// drops every publisher reward (no local stake -> _resolveActiveStakeSourceId
// returns null). At/above this gate: the DOGE indexer stops attempting the
// reward write; the hub inserts one append-only `anchor_reward_attestations`
// row per attested reward tuple after the XANCPUB quorum resolves, mirrored to
// every indexer; and the BTC indexer derives the reward from the mirrored row,
// re-verifying the XANCPUB signatures against its own locally-computed
// oracle_publish/stake set at snapshot_block (the mirror is transport, not
// trust) before materializing validator_rewards there. Below the gate,
// behavior is byte-identical to legacy (DOGE-side write still attempted and
// silently dropped, no BTC-side derivation).
//
// Consensus-relevant (validator_rewards is COLLECT-spendable): must deploy hub
// + all indexers atomically, on the same BTC-anchored snapshot_block space as
// ANCHOR_REWARD_ACTIVATION. It cannot ride the existing 961000/963000
// boundaries because those are already live (0) on testnet/regtest, which
// would flip this relocation the instant code deploys with no coordinated
// deploy-first-then-flip window, risking a COLLECT-mediated fork mid-upgrade.
// That window is what the table was held inert for; every network is now armed
// at genesis, mainnet by the 2026-09-09 ruling, because there is no pre-flag
// reward history on any of them to flip under a partially-upgraded fleet.
//
// PRE-ARMING BLOCKERS (ALL THREE LANDED 2026-08-13, well before any network
// armed). Three consensus defects sat on the derive path
// and were harmless only while this table was inert; arming mainnet or testnet
// before they landed would have forked the COLLECT rail. Their remedies are now
// in code and are described here because the remedies, not the defects, are what
// a ratifier has to verify deployed fleet-wide before picking a height.
//   (1) No mined-anchor proof: the hub wrote the attestation row on mempool
//       acceptance, not confirmation, and the mirrored schema carried no DOGE
//       txid, so a dropped or reorged anchor left its COLLECT-spendable reward
//       intact. CLOSED: the hub holds the row in _deferredRewardAttest until
//       _verifyAnchorOnChain binds that exact txid at that exact ANCHOR version
//       buried dogeConfirmations deep, the mirrored schema gained
//       doge_anchor_txid (idempotent forward migration in xchain-hub AND
//       xchain-indexer), and the BTC indexer re-proves mined depth itself
//       against the DOGE indexer's getanchorconfirmations federation read
//       before createValidatorReward.
//   (2) Non-deterministic materialization: attestations mirrored in with no
//       block-loop barrier, and derivation keyed on snapshot_block <=
//       blockIndex, unrelated to the mirror's arrival time. Two nodes whose
//       copies differed derived the same reward at different heights, forking
//       the ledger hash for identical BTC blocks. CLOSED by the operator's
//       2026-08-11 ruling (a): derivation is re-keyed onto the fleet-agreed
//       mirror-completeness watermark below (ANCHOR_REWARD_MIRROR_MATURITY),
//       and a node whose mirror is not provably caught up DEFERS the block
//       rather than deriving a partial set.
//   (3) The attestation row was never federated: it fanned out only to that
//       hub's own indexer subscribers, so each hub held a disjoint subset of
//       rows and an indexer derived only what its own hub happened to publish.
//       CLOSED: the confirmed write broadcasts the authenticated XANCREWARD
//       peer message, and every receiver re-verifies the XANCPUB quorum against
//       its OWN oracle_publish set at snapshot_block (and re-proves the anchor
//       mined) before writing its copy. The wire is transport, never trust.
//
// PRE-ARMING BLOCKER (4), LANDED 2026-08-24, same class as the three above and
// held to the same rule: remedy in code while this table is inert, operator
// ratifies a height later. The reward LEDGER key could not tell two genuinely
// distinct archive anchors apart. validator_rewards keys on (source_id,
// signing_pubkey_id, reward_type, round_reference), and for 'anchor_archive'
// round_reference is MATCH_BATCH_SEQ - a DENSE counter the hub allocates from
// its own tables, which a wipe-and-replay rebase resets, so the hub reissues
// seq values earlier archive batches already used. The per-chain legs are safe
// by construction (CHECKPOINT_SEQ == snapshot_block, a height that only
// advances). The SIGNED side always distinguished them - the XANCPUB reward
// canonical carries SNAPSHOT_BLOCK and anchor_reward_attestations'
// uq_reward_tuple includes snapshot_block - so the attestation layer knew there
// were two rewards while the ledger conserved one: the pending-attestation NOT
// EXISTS matched round-only and suppressed the second derive outright, and where
// both rows did land the MIN(pubkey) reconcile deleted one real, quorum-attested
// publisher's pay. CLOSED: validator_rewards and anchor_reward_reconcile_log
// carry round_qualifier (snapshot_block for the archive leg, 0 for every other
// reward type, so non-archive rows keep exactly the key they had),
// reward_unique includes it, and the pending join, the reconcile predicate, the
// derive grouping, the reorg restore and xchain-sync's replica-side mirror all
// key on it.
//
// This one has a LEDGER half the other three do not, and it must be verified
// separately before ratification: the columns converge on their own (declared
// with DEFAULTs, so the startup drift reconciler ADDs them), but the UNIQUE KEY
// does NOT - reconcileTableIndexes will not DROP an index it did not create, so
// an AGED database keeps the old four-column reward_unique and merely logs a
// drift warning each boot. So a node can run the new binary and still
// re-collapse two distinct archive rewards inside its own index. Every node
// must therefore carry BOTH the build AND the applied migration
// (xchain-indexer/src/sql/migrations/
// 2026-08-24-validator-rewards-round-qualifier.sql) before any mainnet/testnet
// height is ratified. xchain-sync reads and writes the same replicated table,
// so its build has to be qualifier-aware in the same deploy.
//
// THE HUB'S OWN LEDGER now carries the same qualifier, which it did not when the
// paragraph above was written. src/anchor_reward_key.js is the vendored twin of the
// indexer rule (byte-checked by test/unit/anchorRewardKeyTwinParity.test.js), the
// hub-local validator_rewards.uq_reward includes round_qualifier, and the three sites
// that key on the reduced identity read it: the cross-pubkey dedup guard, the follower
// co-sign cross-check and the archive batch_seq stamp. The hub table is hub-local
// (xchain-sync's replicated validator_rewards is indexer-owned), so this half needs no
// fleet coordination, but an AGED hub still needs runMigrations to widen the key and
// backfill the pre-column archive rows before its verdicts can be trusted.
//
// PRE-ARMING DEPLOY STEP (already fixed in code): a derived reward earns at
// the checkpoint's snapshot_block but materializes at a later BTC block, and
// a reorg delete scoped only on the earn-block leaves a COLLECT-spendable
// reward a from-genesis replay has not derived yet.
// validator_rewards now also carries derive_block_index, and rollback deletes
// on both keys. On the INDEXER side the schema half needs no fleet coordination:
// the columns and the index are declared in xchain-indexer/src/sql/
// validator_rewards.sql and .../anchor_reward_reconcile_log.sql, and the startup
// drift reconciler converges them before runMigrations runs, so any node that
// boots this build has them (the dated migration
// 2026-08-12-validator-rewards-derive-block-index.sql remains the explicit apply
// path, and the runner baselines it once that shape is present). What must
// actually be true fleet-wide before ratifying a mainnet/testnet height is the
// BINARY half: every node running a build whose rollback scopes the delete on
// both keys. A node on an older build has the columns and still scopes on the
// earn-block alone, and forks the COLLECT rail after a reorg. The migration
// ledger never enforced that; the deploy does.
//
// TESTNET IS ARMED AT 0 (operator ruling 2026-08-11, applied 2026-08-14). The
// deploy-first-then-flip window this table was held null for is a MAINNET
// concern: mainnet carries live COLLECT-spendable history, so flipping under a
// partially-upgraded fleet could fork the rail. Testnet was re-genesised with no
// pre-flag history, so there is no legacy set to diverge from and no mid-upgrade
// window to protect; what testnet has instead is the only chance to run the
// relocated derive path (hub attestation write, XANCREWARD federation, BTC-side
// re-verification, mirror-maturity deferral) on a real multi-host network before
// mainnet ratifies a height.
//
// MAINNET IS ARMED AT 0 (operator ruling 2026-09-09). The deploy-first-then-flip
// window above assumed live COLLECT-spendable mainnet history to fork; there is
// none. Mainnet carries 0 anchor reward attestations and 0 validator_rewards rows
// on any chain (measured 2026-09-09), so relocating the derive reinterprets no
// existing reward, and the from-genesis OLD-vs-ON replay per chain is the witness.
//
// TESTNET DEPLOY ORDER, unchanged by the arming: every testnet hub and indexer
// must carry the schema of BOTH
// (2026-08-12-validator-rewards-derive-block-index.sql and
// 2026-08-13-anchor-reward-attestations-doge-anchor-txid.sql) before it processes
// an anchor, since a node on the old schema cannot record the materialization
// block or bind the mined-anchor txid. Read that as a DEPLOY requirement, not a
// ledger one: on a BTC indexer the derive columns arrive with the build (see the
// pre-arming note above), so what to check before an anchor is which build each
// host runs, not which rows its schema_migrations happens to hold.
addGate('anchor_reward_activation.ANCHOR_REWARD_DERIVE_ACTIVATION', 'height', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 anchor reward attestations, 0 validator_rewards rows, measured 2026-09-09)
    testnet: 0,           // ARMED at genesis 2026-08-14 per the 2026-08-11 operator ruling; see the testnet note above
    regtest: 0,
});

// The fleet-agreed mirror-completeness watermark, in BTC blocks (operator ruling (a),
// 2026-08-11, settling AML #4172).
//
// Keying on snapshot_block alone matures a mirrored attestation the instant snapshot_block <= the BTC
// block being processed. snapshot_block is the height the XANCPUB signing set was resolved
// at, and it is ALREADY IN THE PAST when the row is written: the hub writes only after the
// DOGE anchor is buried dogeConfirmations deep, after a failover ladder that can hand the
// publish to a later hub, and after the XANCREWARD federation hop. The maturity key was
// therefore unrelated to the row's arrival, so two nodes whose mirrors differed by one row
// derived the same reward at different BTC heights and forked the ledger hash for identical
// blocks. A hub_db_sync barrier alone cannot fix that: snapshot_block is not a maturity key
// for a mirror whose arrival is governed by DOGE confirmation and hub failover.
//
// Re-keyed: a row matures at snapshot_block + ANCHOR_REWARD_MIRROR_MATURITY, a frozen
// constant every node applies identically, sized to exceed the worst-case arrival lag (60
// DOGE confirmations is ~1h, plus the anchor failover ladder, plus federation). The height
// is only half the barrier. The other half is fail-closed: a node whose attestation mirror
// is not provably caught up DEFERS the block (wait-then-retry, never a partial-set commit;
// see HubDbSync.waitForAnchorAttestationSync), so every node either derives the
// identical set at the identical height or does not advance at all. Changing this value
// moves the block a reward materializes at, so it is a hashed value: it is frozen with the
// activation map above and a change needs its own flag-day.
addGate('anchor_reward_activation.ANCHOR_REWARD_MIRROR_MATURITY', 'constant', 144);   // ~24h of BTC blocks

// The DOGE burial depth deriveAnchorRewards() requires before it will mint a mirrored
// attestation's reward. Frozen HERE, beside the maturity watermark and the activation map,
// because it is a LEDGER input: it decides the BTC height at which a reward materializes,
// so two nodes applying different depths derive the same reward at different heights and
// fork the ledger hash for identical blocks (the same failure ANCHOR_REWARD_MIRROR_MATURITY
// above was re-keyed to close).
//
// It must NOT be read from the coin registry as coins.DEFAULT_CONFIRMATIONS.DOGE, which is
// the wrong authority twice over: the registry classifies `confirmations` as display /
// operator-tunable depth and deliberately leaves it OUT of the pinned consensus subset
// (coins/index.js consensusSubset, coins.test.js NON_CONSENSUS_TOP_LEVEL_KEYS), so a node
// bundling a divergent value forks the derive height while verifyConsensusPin() passes
// clean; and coins.resolveConfirmations() lets an operator move the same number per node
// via XCHAIN_CONFIRMATIONS_DOGE. A ledger input cannot be sourced from a field nothing pins
// and anyone may tune, so the block-transaction path takes it from here and the registry
// field means what it is classified as: local, hub-side trust policy.
//
// The value equals the registry default at rest and a drift alarm in
// test/unit/anchorRewardDerive.test.js fails if the two ever part. Changing it moves the
// block a reward materializes at, so it is frozen with the activation map above and a
// change needs its own flag-day.
addGate('anchor_reward_activation.ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS', 'constant', 60);   // DOGE confirmations, ~1h

// Sized against the hub's whole MEASURED write-lag envelope, not the DOGE burial alone. The
// envelope is about 15 h: up to 6 BTC blocks of checkpoint age at flush (~1 h), the
// publisher's deferred-write queue TTL of 6 h, a receiver hub's re-proof through that SAME
// queue for up to 6 h more, and ~2 h of raw-stamp skew on the networks that are off
// median-time-past.
//
// 64800 s covers that envelope with 3 h of headroom and still opens 6 h before a nominal
// 144-block span, so a +2 h stamp is absorbed entirely. The earlier 21600 s figure was sized
// on the DOGE burial alone and sat BELOW the publisher's own 6 h queue TTL, so it was
// corrected by measurement. A 144-block stretch shorter than 18 h is a three-sigma event and
// falls back to today's wait through the min(), which is the right way for a fail-closed
// gate to fail. Changing this value moves the block a barrier opens at, so it is frozen with
// the activation map below and a change needs its own flag-day.
addGate('anchor_reward_activation.ANCHOR_ATTEST_ARRIVAL_MARGIN_S', 'constant', 64800);   // 18 h

// Per NETWORK, not per (coin, network), because this member is BTC-only by its call-site
// guard and a second key would be dead weight. Nothing hashed moves across this height: two
// nodes on either side derive the identical set at the identical height and differ only in
// WHEN they get there. The height exists because a rolling deploy would otherwise leave the
// early-opening node alone in carrying a weaker completeness guarantee, and one map removes
// that window.
addGate('anchor_reward_activation.ANCHOR_ATTEST_BARRIER_ACTIVATION', 'height', {
    mainnet: null,        // INERT under the 2026-08-29 mainnet write hold
    // SIZED 2026-09-16 20:41Z, RE-SLID 2026-09-19 and 2026-09-23, on the BTC clock because this
    // member is BTC-only: the same instant as the family's BTC CONSUMER height, so the one
    // member that keeps BOTH certificates gains them together rather than carrying a lone extra
    // rule for 6 h. The canon carries the measurement.
    testnet: 154291,
    regtest: UNPINNED,   // shares the family's arming seam so one venue lever arms both
});

// archive_rollback_author_scope_activation
// Per-network activation, interpreted against the block index a rollback targets,
// on the DOGE scale (see the KEYED ON note above).
addGate('archive_rollback_author_scope_activation.ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION', 'height', {
    mainnet: 0,            // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 archive chunks, measured 2026-09-09), and ARCHIVE_BATCH_AUTHOR is 0 there too, so the precondition holds
    testnet: 67915000,     // testnet runs a public chain with live history, so 0 would be retroactive rather than a flag day; TDOGE tip 67881714 on 2026-09-09 + 33286 blocks @1440/day = ~23 days, to ride the v0.17.0 train
    regtest: 9999999999,   // INERT sentinel: keeps the flag-day-off control path drivable on a throwaway stack
});

// The joins that bind an orphaned chunk to its own head's author. Spliced into
// the reset UPDATE by both the source indexer and the replica so the two cannot
// drift; `c` is the orphaned chunk and `p` the surviving head, as named there.
addGate('archive_rollback_author_scope_activation.ARCHIVE_AUTHOR_SCOPE_JOIN_SQL', 'constant', 'JOIN actions         pact ON pact.action_index = p.action_index ' +
    'JOIN index_addresses padr ON padr.id = pact.source_id ' +
    'JOIN actions         cact ON cact.action_index = c.action_index ' +
    'JOIN index_addresses cadr ON cadr.id = cact.source_id AND cadr.address = padr.address ');

// attest_relay_activation
// Per-network activation height, interpreted as the BTC-anchored SNAPSHOT_BLOCK
// carried by the relay canonical (NOT the local processing height), so BTC, LTC,
// DOGE and the hub all flip the relay legs on one anchor.
addGate('attest_relay_activation.ATTEST_RELAY_ACTIVATION', 'height', {
    mainnet: 963000,      // ARMED 2026-07-30, RE-PINNED 2026-08-12 off block 969500 with the rest of the coordinated mainnet activation cohort; deploy every indexer + hub before this height
    testnet: 0,
    regtest: 0,
});

// attest_relay_reject_slot_activation
// Per-network activation, interpreted against the LANDING block's consensus
// timestamp (data['BLOCK_TIME']) on the home chain.
addGate('attest_relay_reject_slot_activation.ATTEST_RELAY_REJECT_SLOT_ACTIVATION', 'time', {
    mainnet: 0,             // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 attestations, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
});

// attest_response_mirror_activation
// Per-network activation height (LOCAL COPY, parity-tested). Compared against
// the ATTEST v0 request's own BTC block_index (the v3's, for a relayed request).
addGate('attest_response_mirror_activation.ATTEST_RESPONSE_MIRROR_ACTIVATION', 'height', {
    mainnet: null,        // INERT: operator-owned height, unratified. The legacy on-chain response path runs byte for byte.
    testnet: 151324,      // ARMED 2026-09-07 at the chain tip on the operator ruling: exercising the mirror on testnet is the point of this train, so it activates on deploy rather than waiting on a future height.
    regtest: 0,           // ARMED at genesis so the e2e mirror venue exercises the mirror path
});

// attest_responsible_widening_activation
// Per-network activation height (LOCAL COPY, parity-tested). Compared against
// the ATTEST v0 request's own BTC block_index.
// MAINNET IS ARMED AT 0 by the 2026-09-09 ruling. Widening only changes who may sign a
// round that has already failed to finalize, and 0 attestations have ever been recorded on
// any mainnet chain (measured 2026-09-09), so no admitted request is reinterpreted; the
// from-genesis OLD-vs-ON replay per chain is the witness.
addGate('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION', 'height', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 attestations, measured 2026-09-09)
    testnet: 150780,      // ARMED 2026-09-02. Tip was 150760 at 17:08Z running 20 min/block, so ~20 blocks (~6.5h). Sized to OUR fleet's deploy wave, not to the community's, and the SAFETY comes from deploy ORDER rather than from this margin: only an upgraded hub can PRODUCE a widened ATTEST v1, so indexers upgraded before hubs leaves no divergence window even if the height arrives mid-deploy.
    regtest: 0,           // ARMED at genesis so the e2e venue exercises the ladder
});

// The ladder's own constants (LOCAL COPY, parity-tested).
//
// FROZEN, and deliberately NOT the hub's operator-tunable ATTESTATION_CONFIRMATIONS /
// ATTESTATION_LEADER_ROTATION_BLOCKS. Those two shape only which hub goes first, which no
// validator checks; these shape WHO MAY SIGN, which every indexer checks. Sourcing them from
// per-hub config would let one operator's tuning fork the set. (Above
// ATTEST_ZERO_CONF_ACTIVATION the hub's confirmations knob is inert anyway: the hub serves
// at the tip, AttestationRound.confirmationsFor, and its ladders start where this one does.)
//
// PROPORTIONAL TO THE REQUEST'S OWN WINDOW, not a fixed block count, and that choice is the
// whole reason this ladder is usable. A fixed window sized to sit after leader rotation's cap of
// 3 never fires at all inside a short deadline: the case this exists for (deadlineBlocks 10,
// confirmations 3) leaves 7 serviceable blocks, and rotation alone consumes every one of them.
// So the serviceable span is divided into `maxSlots + 1` equal segments, one per widening level,
// exactly as attestation_escalation.modelIndex divides the same span across approved models. A
// contract that asks for a long window gets a long grace period before its set widens; one that
// asks for a short window gets a proportionally short one, and both still widen.
//
// maxSlots 2 bounds how far the pool can grow: enough to absorb two dead members of a set, small
// enough that the deterministic assignment stays the dominant property. The first segment is
// always the unwidened set, so a healthy round never sees a widened set at all.
addGate('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING', 'constant', {
    confirmations: 3,
    maxSlots:      2,
});
// SHARED-GATES END
