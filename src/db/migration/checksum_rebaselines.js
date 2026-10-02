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
 * XChain Indexer - the reviewed migration checksum rebaselines
 *
 * The one table the runner consults before failing closed on an applied file whose
 * content changed. migration_tables.js re-exports it onto Database as a static.
 *
 ********************************************************************/

'use strict';

// Applied-migration files whose checksum may be healed in place. Each entry maps
// a `from` predecessor hash (or a list of them) to a single `to` hash pinned to a
// reviewed edit; anything else still fails the immutability guard in runMigrations().
// `from` may be a list because one reviewed edit can supersede several historical
// file revisions and each DB recorded whichever revision it applied first (mirrors
// the sibling xchain-decoder ledger).
const MIGRATION_CHECKSUM_REBASELINES = {
    // ba430f8 retagged the DROP from mode=auto to mode=manual (safety fix);
    // the executable statement is unchanged.
    '2026-06-16-drop-orphaned-contract-balances.sql': {
        from: '287d7bdb0b1a27308bdfd5a433f659aa466e3856f55b361a8b2e89a4ad146f76',
        to:   '70de5f0ee1146c569b62c75cddb77be8eba72b9963a066b5059f05de15ccdef2',
    },
    // Added `AFTER state_key` so the migration lands the generated column in the same
    // position contract_state.sql declares it (column-order convergence, aged vs fresh).
    // A DB that already applied the old file has the column at the tail; the clause is
    // guarded by IF NOT EXISTS, so re-reading the new file is a no-op there and only the
    // ledger checksum needs to heal. The tail position itself is converged by a SEPARATE
    // migration, 2026-07-16-reposition-state-key-bin.sql (MODIFY ... AFTER state_key,
    // mode=manual), which is what makes an aged install match a fresh SHOW CREATE TABLE;
    // this entry heals the ledger only and moves no column.
    //
    // NOT A PRECEDENT. An executable edit is rebaselined here only when IF NOT EXISTS makes
    // the re-read a true no-op AND a follow-up dated migration carries the real convergence
    // (this entry and 2026-09-03-attestation-responses.sql are the two). An executable edit
    // that changes what an already-applied file DOES still needs its own dated migration;
    // this table only ever heals the ledger.
    '2026-07-10-contract-state-bin-key-index.sql': {
        from: '04656bbe931851e254f51c2f4552e8e0ab2c47067cb7eb39dcbb7f4695d38dd1',
        to:   '15599a2f13a372767468cd72ec05b7dff50d03e095e77cd40ee16bcba52754c6',
    },
    // Two of the three renamed legacy migrations carry their own filename inside
    // the "HOW TO RUN" comment block, so 81960e2 (the rename) had to update that comment
    // line as well. The ledger rename heal re-keys the ROW NAME but deliberately carries
    // the recorded checksum over unchanged, so every DB migrated before 2026-07-12 (the
    // whole prod fleet) then compared a pre-rename hash against the post-rename file and
    // logged `content CHANGED` on every single start. A guard that always fires cannot
    // report a real migration edit, so both files are rebaselined here.
    //
    // Each `from` list is the file's complete set of pre-current committed revisions since
    // the ledgered runner existed (351604c); every delta between them and `to` is a comment
    // line only, verified by diff:
    //   351604c-era -> 81960e2 : the HOW TO RUN path comment gained the dated filename.
    //   397e373     -> 88469e6 : the license-header sweep prepended a 14-line banner and
    //                            was reverted the same day for exactly this reason; a DB
    //                            that migrated inside that window recorded the banner hash.
    // The executable DDL is byte-identical across all of them, so re-reading the current
    // file against a DB on any of these revisions would be a no-op. Revisions older than
    // 351604c are intentionally NOT listed: no ledger existed to record them.
    '2026-06-03-unique-full-column-index-addresses.sql': {
        from: [
            '9fdbbcbda36b860a3214d5fcc3d057f3bdf413a99c9d5407e7ef9951a318fb1e', // 351604c, pre-rename
            '8193fe4eca04ac802b5963a7f3b100bf2b3f3103aaeb18e8eb5ff88b8f5f557d', // 397e373, header sweep
        ],
        to: 'a5ffca0798dc5e58c15f2dce7d678452666fef4814d7b560bc4b39c89c1f7dc5',
    },
    '2026-06-09-cross-chain-matches-partial-fill-columns.sql': {
        from: [
            '289d9fe5fb41f8012e7cbcdb3d6c2e2a8c983ca84afd920d73b386a33d64e602', // 351604c, pre-rename
            '7fe66226c936023b72121c24fb3cfbea5bd4e52e70964542a6617f12b2a74451', // 397e373, header sweep
        ],
        to: '5adb9505a4986bd5a0d0c82bf1fff46a39621c7a2d17b4846d5d51eb224bc20e',
    },
    // The licence-header sweep (f1161ec) rewrote the comment block at the top of every
    // migration file AFTER the fleet had applied these ten, so every database that ran
    // them before the sweep records the pre-sweep hash. Verified one by one rather than
    // assumed: strip `--` lines and blanks and the residue hashes IDENTICALLY to HEAD for
    // all ten, so no executable SQL moved and the ordinary contract above is met.
    //
    // FIVE of the ten had to be recovered from ORPHANED BLOBS: the published-history
    // rewrite left their pre-sweep revisions unreachable from any commit, so a `git log`
    // range finds nothing and only a scan of the whole object store (6241 blob candidates)
    // turns them up. Note the recorded value is a SHA-256 of CONTENT while git object names
    // are SHA-1, which is why the recorded hash never appears as an object name.
    // BTC, LTC and DOGE mainnet all record the SAME hash per file, so one `from` each.
    '2026-07-05-polls-binding-callback-columns.sql': {
        from: '2c6bb959768a2fd2c87bbefadefdd51710c305652c31146cdb8f8996ad0b38e4',
        to:   'abcd714f3fbf1e42919b09240329165cc1a811b5615d7c993e9534ed97dcfa73',
    },
    '2026-07-16-mirror-id-unsigned-align.sql': {
        from: '9e03175bbec77d4143e32ee5cbe71324937fac970291a65b041a964bf93aafa0',
        to:   '59fa518e404d94638b802c2a1db7ec2cc67df5ce4575148eca265048a794b92a',
    },
    '2026-07-18-status-tables-status-action-composite-idx.sql': {
        from: 'e85523f8acb1baa97d62d10f638de660ab850eb453a11411a9da3b8199aeede0',
        to:   '4cf53571267b133ca276dc5dd83b12e3ca94befd009757d6c2c1c9fe213459ae',
    },
    '2026-07-21-anchor-reward-attestations-table.sql': {
        from: '3ccac829d5c9ad0a0f4f8e3c216ad15c1923ebd4bc61e747dd76928c3d3f8e3d',
        to:   '5574ccc85e4a11dc24956fc2ea2efac4846c4768b03a24bba442cd7c1f2efe00',
    },
    '2026-07-26-bet-cancel-resolve-status-tables.sql': {
        from: '4fa4a1ad6f5c31b8ba1417159110263d94f6b63f83636e42c089238fbf49eead',
        to:   'd24b3fe5395e7d77a8640822efaa6239779d538cc705d67fec48999276cded85',
    },
    '2026-07-28-escrow-leaf-journal-table.sql': {
        from: '8d55e8c4e54cdfe63339ba6acc8a5e719c1a4a3a00953906704a1d6ea63a46f2',
        to:   '7bc8813dee9e63245b65f4ec91a377ff47ecbad031286ce5d04a69ccad21fe2e',
    },
    '2026-07-28-state-tree-roots-contract-state-root.sql': {
        from: '85dcb71f52a46f18a37f25949b04d3fc6b3b98b0bb31e43a3fd5a1d9b7220ac5',
        to:   'c3d1c8e4ef77a026de76b4fc17024cb043315e42f059f15b70727212e83aa7d5',
    },
    '2026-07-28-state-tree-roots-escrow-shadow.sql': {
        from: 'd83b25e94261e24b7a545999e0332aab44364d5a1efc39c9a36786daae53bc10',
        to:   '3240968ff925d609b9a5d699f16f7226f05bda884cc4b367d29923352a5c3c64',
    },
    '2026-07-29-gated-files-threshold-and-publisher.sql': {
        from: '2e93b7eda5ca01be23dfc18c9ea137cbf72d3c4c0279150be9930e46f28b72b9',
        to:   '6d900aac43b92e41c6fac1ee3ea1fb27785803751ec1e94b9440919a64621b36',
    },
    '2026-07-30-attests-add-relay-origin-columns.sql': {
        from: '27a69b77def4039fc199963c2c4523e45db5e896c36f5ca34c43a81f07b5d9d7',
        to:   'e8c3645589499c3d5331bb1a7d4e2d4afd8cf52230f2db149508a35db16e554b',
    },
    // Added the `deploy-precondition=required` header tag (and the comment explaining
    // it) so the deploy tool can see, from the source tree it is about to deploy, that
    // this migration is a startup-assertion precondition. Comment lines only; the
    // executable ALTER is byte-identical. All three mainnet indexers applied this file
    // on 2026-08-09 and recorded the single pre-tag revision (68b65e7, its only
    // committed revision), so one `from` covers the fleet.
    '2026-07-24-pubkeys-widen-uncompressed.sql': {
        from: '2275f44bb043fe473b7781f08e5ce30253c1148e52ba2709efb5fb1214f282d2',
        to:   '45a8fd3f4ce71360a1777bd1b86f14eb534259cffa651f76be5c15afafd50657',
    },
    // Corrected a FALSE provenance note. The file claimed it was a no-op "on any install
    // whose boot-time drift reconciler has already converged the column in", but the
    // reconciler can never converge attest_validator_stats.id: parseExpectedColumns reads
    // AUTO_INCREMENT / PRIMARY KEY as NOT NULL with no DEFAULT and alterTableForDrift skips
    // that shape outright, so this migration is the SOLE convergence path for an aged
    // install. That note is what a later baselining or squash pass reads, and believing it
    // would drop the file and strand every replay-converged replica without the paging
    // primary key. Comment lines only; the single ALTER TABLE is byte-identical (verified by
    // comparing the comment-stripped residue). 55a9621 is the file's only committed
    // revision, so one `from` covers every DB that applied it; where none has, the entry is
    // simply inert.
    '2026-08-19-attest-validator-stats-surrogate-id.sql': {
        from: '0f8f54622b7022134b140d1f68a86ea91d763c6a51e9886ee0b741961df34dc7',
        to:   'ecb9c206ebda43ba932603d60d6d470ab47704db428ff81f42d16c36b983acbb',
    },
    // The header claimed mode=manual coordinated the fleet; it cannot (the drift
    // reconciler converges all three objects at verifyTables(), before runMigrations()
    // reads the gate), so the WHY/mode block was rewritten to state what the tag does
    // and does not do. Comment lines only: the three ALTER TABLE statements are
    // byte-identical, verified by comparing the comment-stripped residue. Both of the
    // file's pre-current committed revisions are listed - afee252f (the original) and
    // 758fc1db (a comment cleanup) - since each fleet DB recorded whichever it applied
    // first; on any database that never applied the file by hand the entry is inert.
    '2026-08-12-validator-rewards-derive-block-index.sql': {
        from: [
            '8f6f8b6bae2026128b0b298892fc0b5601a67f2ff12cc05fb4da9ae9cfdd1100', // afee252f, as authored
            '8496c4f75647ad9768d8128e8f9341e3d4de9a1db5ca2f66d4328762ab0a9ec3', // 758fc1db, comment cleanup
        ],
        to: 'a911c38ca928743bb65c763c8143a5a3ad63de18da72b32da83a4971c1735ed8',
    },
    // The same 758fc1db comment cleanup (internal-reference scrub) caught three more
    // already-applied files, and unlike the entry above these were never rebaselined, so
    // every aged testnet/regtest DB logged `content CHANGED` on each start AND - the part
    // that actually bites - `node src/db/migration/migrate.js` FAILED CLOSED on the first of them, which
    // made the whole pending manual backlog unappliable on those hosts. Found 2026-08-26
    // while working that backlog; the startup warning had been dismissed as noise for two
    // weeks, which is exactly the failure mode a guard that always fires produces.
    //
    // Comment lines only in all three, verified by comparing the comment-stripped residue
    // rather than assumed: the scrub removed internal ticket ids and an internal tracker
    // reference from the header prose. The executable SQL is byte-identical.
    //
    // The third file's predecessor was an ORPHANED BLOB, unreachable from any commit (the
    // published-history rewrite, same cause as the five noted above), so `git log` finds
    // nothing for it; it was recovered by scanning the whole object store (2586 blob
    // candidates) and only then compared. Mainnet is NOT affected: the BTC mainnet ledger
    // already records the current hash for all three, so this heals aged non-mainnet DBs.
    '2026-07-16-mirror-twin-bigint-unsigned-align.sql': {
        from: '1d981cd5d128c2ec8de391289b11fdc43932f65ee5d3fd8a61c32e7b01be0569', // fd9267e2, pre-scrub
        to:   'fac090271fd2cebaea9b914d344f94483d97d0ec5b7854bf42263df0153c1d48',
    },
    '2026-07-26-tokens-backfill-lock-mint-supply.sql': {
        from: '03ec334fdfafd207d5ca7d39887422175ab0ed9f83947c21a6d30c2391419215', // ef66d9e3, pre-scrub
        to:   'f2e53e5a3de9f08b162528323b6cb78bbbddf9591859bf555313801929689c84',
    },
    '2026-07-29-state-checkpoints-uq-chain-seq.sql': {
        from: '05dfd2ef7d246929a451521aa7c4c6e0f21faf019dd06f1f16384a450675267c', // orphaned blob 8a293ccf, pre-scrub
        to:   '0796c26842434c39b056e9875ba5ee7dbbcfd92d340e2899f7921e03147c5458',
    },
    // Added the `deploy-precondition=required` header tag (and the DEPLOY PRECONDITION
    // comment block explaining it) when the reward-identity startup assertion landed, the
    // same retag the pubkeys widen carries above. Comment lines only: the four ALTER TABLE
    // statements are byte-identical, verified by comparing the comment-stripped residue
    // against the pre-tag revision rather than assumed. a0dd6d08 is the file's only
    // committed revision, so one `from` covers every database that applied it by hand;
    // where none has, the entry is inert.
    '2026-08-24-validator-rewards-round-qualifier.sql': {
        from: '069f0e73f1cb6179d0dcab361832204c96aa1cb4072454ddcd7e6a8acd2d31ab', // a0dd6d08, pre-tag
        to:   '37ff284b7f11f248e9f52979f70e5fe8f13c9cad7a7e719b4633866e8c81dc1a',
    },
    // a06f8873 (2026-09-17) rewrote two comment lines of this already-applied file (the
    // header cited an internal spec path). Comment lines only; the executable SQL is
    // byte-identical, verified by diff against the first revision, 8c50c9d4. That revision
    // lived on develop for about 15.5 h and no release tag carried it, but a regtest DB
    // that migrated inside the window recorded its hash and logged `content CHANGED` on
    // every start. One `from` covers it; where no DB applied it, the entry is inert.
    '2026-09-16-admission-height.sql': {
        from: 'a2ebe4379b888e86c79a40f8e9648fd37516bd616f30844f432e104258bc1dba', // 8c50c9d4, pre-comment-edit
        to:   'd9c0dd3e0e35a698684d5740fd0e2937ea375b034a5977c50405befe2a579dc7',
    },
    // Two EXECUTABLE in-place edits, the second case the NOT A PRECEDENT note above allows:
    // batch_action_index was added inside the CREATE TABLE and uq_attest_response widened to
    // (network, request_id, effective_time). Every statement is CREATE ... IF NOT EXISTS on a
    // name an older revision already created, so re-reading the current file there is a
    // no-op, and dated migrations carry the convergence: 2026-09-06-attestation-responses-
    // identity-effective-time.sql rebuilds the key, 2026-10-01-response-mirror-batch-action-
    // index.sql adds the column. Without this entry `node src/db/migration/migrate.js` fails
    // closed here on any DB that applied an older revision, blocking every later manual file.
    // The residue of every revision listed differs from HEAD only in those two statements
    // (and the index IF NOT EXISTS clauses edea35b2 lacked), verified by diff; two are orphaned
    // pre-scrub blobs recovered from the object store.
    '2026-09-03-attestation-responses.sql': {
        from: [
            'c028fdb826fcb203f64817bbe957bd59d24efee940985ed610d475eaa9eb12ad', // edea35b2, as authored
            'd5444bd9f34f2b5199ecce88a72213f4ab72ab1ea607a498b0788a846f2602c2', // orphaned blob 396affde, edea35b2 pre-scrub
            '20e1d3acfc44d0c8e98cdb65bbcdf84fde4a8d94523643932d36fdf3024d424c', // 350109bc, idempotent indexes
            '181e9f2736dfde667e10d25cae17d06f65f03c2e22b7ad2b5e2efdd6c40bc02d', // orphaned blob 28641b48, 350109bc pre-scrub
            'f1b068d32e4eedafb969e5e6eb0c74526ef45ab30043b770d2498a313b3a23b0', // d69b8a46, batch_action_index added
            '59fcbbb1b7c93acde903d1aff9dbd2c0a350f1ad09f83ec020fc91cce01888e3', // 6f226b37, index comments
        ],
        to: '3ce329fb2d98b14d7b61aa892fed9ef483957eba6da77e708912efaf24318d09',
    },
};

module.exports = { MIGRATION_CHECKSUM_REBASELINES };
