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
 * XChain Indexer - Database class part: migration data tables
 *
 * Runner-side data tables keyed by migration filename: the reviewed checksum rebaselines and
 * the live-schema preconditions. db/index.js assigns both onto Database as statics.
 *
 ********************************************************************/

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
    // NOT A PRECEDENT. It is the one executable edit rebaselined here, and only because
    // IF NOT EXISTS makes the re-read a true no-op AND that follow-up migration carries the
    // real convergence. An executable edit that changes what an already-applied file DOES
    // still needs its own dated migration, never an entry in this table.
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
};

// Applicability preconditions the runner evaluates against the LIVE schema before it
// applies a migration (see migrationPreconditionSkip). Each entry is a parameterised
// information_schema query taking the database name, plus a predicate returning a reason
// string when the migration does not apply to this database and null when it does.
//
// The guard lives HERE rather than inside the .sql file on purpose: a migration file's
// sha256 is its identity in schema_migrations, so adding a guard clause to an already
// applied file would trip the immutability check on every node that ran it, and healing
// that needs a MIGRATION_CHECKSUM_REBASELINES entry whose documented contract is that the
// executable SQL is byte-identical across pinned revisions. A runner-side predicate keeps
// both properties intact and covers every invocation route (startup, blanket
// `node src/db/migration/migrate.js`, and a targeted `--file` rollout), since all three funnel through
// this loop. Mirrors xchain-decoder/src/db.js.
const MIGRATION_PRECONDITIONS = {
    // Widens pubkeys.pubkey to hold an uncompressed key (130 hex chars). It is
    // mode=manual, so it stays PENDING on a database created from the current
    // src/sql/pubkeys.sql (already VARCHAR(130) or wider) - and a fresh install never
    // needs the widen a prior narrower column required. Baseline only while the live
    // column is already 130 characters or more, the same threshold
    // assertPubkeyColumnIsUncompressedWide enforces at startup.
    //
    // Absent table/column, or an unreadable/NULL length, is deliberately NOT
    // baselined: that state needs an operator, and the startup assertion fails
    // closed on it (a non-character type or a missing column returns early there,
    // leaving the migration's own PENDING state as the only signal).
    '2026-07-24-pubkeys-widen-uncompressed.sql': {
        sql: "SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.columns " +
             "WHERE table_schema = ? AND table_name = 'pubkeys' AND column_name = 'pubkey'",
        skipWhen: (rows) => {
            // No column, or a length we could not read: never baseline on an absent
            // answer, let the file speak for itself and the assertion fail closed after it.
            if(!rows.length || rows[0].len == null) return null;
            const len = Number(rows[0].len);
            if(Number.isNaN(len)) return null;
            if(len >= 130) return 'pubkeys.pubkey is already ' + len + ' characters wide, so there is no narrow column to widen.';
            return null;
        }
    },
    // Adds validator_rewards.derive_block_index (+ its index) and
    // anchor_reward_reconcile_log.reward_derive_block_index. It is mode=manual, but
    // unlike the surrogate-key case alterTableForDrift documents as its BLIND SPOT
    // (AUTO_INCREMENT / PRIMARY KEY), the drift reconciler CAN converge every object
    // it adds: both columns are nullable-with-DEFAULT in
    // src/sql/validator_rewards.sql and src/sql/anchor_reward_reconcile_log.sql (so
    // alterTableForDrift ADDs them rather than hitting the NOT-NULL-no-DEFAULT skip),
    // and the index is non-unique (so reconcileTableIndexes adds it unconditionally).
    // verifyTables() runs before runMigrations() at startup, so on a fresh or aged
    // install the end state is already in place by the time this file is read. The
    // ledger row records what is true there; without it the file sits PENDING with no
    // row forever and every operator run re-lists a no-op.
    //
    // ONE bind parameter: migrationPreconditionSkip passes [this.dbName] and nothing
    // else, so the database name is bound once in a CTE and reused by each subquery.
    //
    // A partially converged or unreadable schema is deliberately NOT baselined: any
    // missing object, or a count that will not parse, returns null and the file runs,
    // which is idempotent (IF NOT EXISTS throughout) on whatever is already there.
    '2026-08-12-validator-rewards-derive-block-index.sql': {
        sql: "WITH p AS (SELECT ? AS db) SELECT " +
             "(SELECT COUNT(*) FROM information_schema.columns, p WHERE table_schema = p.db " +
             "AND table_name = 'validator_rewards' AND column_name = 'derive_block_index') AS reward_col, " +
             "(SELECT COUNT(*) FROM information_schema.columns, p WHERE table_schema = p.db " +
             "AND table_name = 'anchor_reward_reconcile_log' AND column_name = 'reward_derive_block_index') AS log_col, " +
             "(SELECT COUNT(*) FROM information_schema.statistics, p WHERE table_schema = p.db " +
             "AND table_name = 'validator_rewards' AND column_name = 'derive_block_index') AS reward_idx",
        skipWhen: (rows) => {
            if(!rows.length) return null;
            const row = rows[0] || {};
            const counts = [row.reward_col, row.log_col, row.reward_idx];
            for(const raw of counts){
                if(raw == null) return null;
                const n = Number(raw);
                if(Number.isNaN(n) || n < 1) return null;
            }
            return 'validator_rewards.derive_block_index (with its index) and ' +
                   'anchor_reward_reconcile_log.reward_derive_block_index are already present, ' +
                   'converged from the table definitions by the startup drift reconciler, so this ' +
                   'migration has nothing left to add.';
        }
    },
    // Adds validator_rewards.round_qualifier and anchor_reward_reconcile_log.round_qualifier,
    // and REBUILDS validator_rewards.reward_unique to include the qualifier. It is mode=manual,
    // and unlike the derive-block entry above the drift reconciler converges only PART of that
    // end state: both columns are NOT NULL *with a DEFAULT* in src/sql, so alterTableForDrift
    // ADDs them, but reconcileTableIndexes never DROPs an index name already held by a
    // differently-defined live index, so an AGED database keeps the four-column key and logs a
    // "cannot be applied" drift warning every boot. A database CREATED from the current src/sql
    // gets the five-column index directly from validator_rewards.sql (createTable executes every
    // statement in the file, including its CREATE UNIQUE INDEX), so it needs nothing from this
    // file and would otherwise sit PENDING with no ledger row forever.
    //
    // The predicate keys on the LIVE INDEX SHAPE, not on the column, and that is the whole point.
    // The columns arrive on their own, so a column-only test would baseline exactly the database
    // this migration exists for: qualifier column present, reward_unique still four-column, the
    // qualifier-aware writers silently re-collapsing two distinct archive rewards. That state
    // must NOT be baselined, so the index check is the gate and the columns are only a
    // completeness check on the other half of the file.
    //
    // ONE bind parameter: migrationPreconditionSkip passes [this.dbName] and nothing else, so
    // the database name is bound once in a CTE and reused by each subquery.
    //
    // non_unique = 0 is asserted, not assumed: a same-named NON-unique index carrying the
    // qualifier would satisfy a name-and-column test while deduplicating nothing.
    //
    // Any missing object, a partial shape, or a count that will not parse returns null and the
    // file runs, which is idempotent (IF [NOT] EXISTS throughout, and the DROP/ADD index pair
    // re-creates an identical definition).
    '2026-08-24-validator-rewards-round-qualifier.sql': {
        sql: "WITH p AS (SELECT ? AS db) SELECT " +
             "(SELECT COUNT(*) FROM information_schema.columns, p WHERE table_schema = p.db " +
             "AND table_name = 'validator_rewards' AND column_name = 'round_qualifier') AS reward_col, " +
             "(SELECT COUNT(*) FROM information_schema.columns, p WHERE table_schema = p.db " +
             "AND table_name = 'anchor_reward_reconcile_log' AND column_name = 'round_qualifier') AS log_col, " +
             "(SELECT COUNT(*) FROM information_schema.statistics, p WHERE table_schema = p.db " +
             "AND table_name = 'validator_rewards' AND index_name = 'reward_unique' " +
             "AND column_name = 'round_qualifier' AND non_unique = 0) AS key_col",
        skipWhen: (rows) => {
            if(!rows.length) return null;
            const row = rows[0] || {};
            const counts = [row.reward_col, row.log_col, row.key_col];
            for(const raw of counts){
                if(raw == null) return null;
                const n = Number(raw);
                if(Number.isNaN(n) || n < 1) return null;
            }
            return 'validator_rewards.reward_unique already carries round_qualifier and both ' +
                   'round_qualifier columns are present, so this database is already on the ' +
                   'qualified reward identity and this migration has nothing left to rebuild.';
        }
    },
};

module.exports = {
    MIGRATION_CHECKSUM_REBASELINES,
    MIGRATION_PRECONDITIONS,
};
