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
 * test/integration/anchor-reward-late-publisher.test.js
 *
 * Runs the anchor-reward derive fetch gate against a REAL MariaDB ().
 *
 * getPendingAnchorRewardAttestations() decides which mirrored attestations ever
 * reach reconcileAnchorRewardWinner(), and its whole content is a correlated
 * NOT EXISTS. Its unit sibling (test/unit/db.queries.test.js) stubs doQuery and
 * can therefore only assert the SQL's SHAPE - it never asks MariaDB anything. For
 * a raw predicate that is not enough twice over:
 *
 *   - doQuery() SWALLOWS a non-transactional query error and returns [], so a bad
 *     join or an illegal mix of collations would not raise here, it would silently
 *     derive NO anchor rewards on a live node while every unit assertion stays green.
 *   - the defect being fixed is a SEMANTIC one about row sets across two calls, and
 *     a shape assertion cannot tell a publisher-scoped exclusion from a round-scoped
 *     one actually behaving differently on real rows.
 *
 * So this file drives the failover scenario itself: a second publisher's attestation
 * mirrors in AFTER the round was already derived and reconciled. The round-scoped
 * predicate suppresses it forever (divergent COLLECT credit across nodes, no
 * self-healing path); the publisher-scoped one re-admits it only when it would WIN,
 * so both arrival orders converge on the smallest signing pubkey and a settled round
 * never re-derives.
 *
 * Self-skips when TEST_DB_PASS is unset, matching the other DB-backed files here.
 * Run it with bin/run-db-tiers.sh.
 */

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const { getTestConfig } = require('../fixtures/config');
const Utility  = require('../../src/utility');
const Database = require('../../src/db');

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT) || 3306;
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS;            // undefined => self-skip
const DB_NAME = 'xchain_anchor_reward_late_publisher';

const SQL_DIR = path.join(__dirname, '../../src/sql');
// Strip `--` line comments with the PRODUCT's own stripper, for the reason
// recovery-id-determinism.test.js documents: the licence banner starts `--***` with
// no whitespace, which MySQL does not treat as a comment, so a verbatim send is
// errno 1064 on the first line.
const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const SCHEMA = ['index_pubkeys.sql', 'validator_rewards.sql',
                'anchor_reward_attestations.sql', 'anchor_reward_reconcile_log.sql']
    .map(f => stripSqlLineComments(fs.readFileSync(path.join(SQL_DIR, f), 'utf8')))
    .join('\n');

// Two publishers for one logical reward, as a failover double-publish produces.
// SMALL sorts lexicographically below LARGE, so SMALL is the fleet-wide winner
// whichever order the two attestations happen to mirror in.
const PK_SMALL = '0a'.repeat(32);
const PK_LARGE = 'f0'.repeat(32);
const RTYPE    = 'anchor_BTC';
const SNAP     = 100;
const SOURCE   = 1;                                  // staking address; irrelevant to the gate

function makeDb() {
    const config = getTestConfig();
    const util   = new Utility();
    return new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, { config, util });
}

describe('anchor-reward derive fetch gate against a real MariaDB () @tier3', function () {
    this.timeout(60000);

    let db, pubkeyId = {};
    const ROUND = 4174;

    before(async function () {
        if (!DB_PASS) this.skip();
        const admin = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, multipleStatements: true });
        await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME + '; CREATE DATABASE ' + DB_NAME + ';');
        await admin.query('USE ' + DB_NAME + '; ' + SCHEMA);
        await admin.end();

        db = makeDb();
        const conn = await db.getConnection();
        try {
            for (const pk of [PK_LARGE, PK_SMALL])
                await conn.query('INSERT INTO index_pubkeys (pubkey) VALUES (?)', [pk]);
            for (const r of await conn.query('SELECT id, pubkey FROM index_pubkeys'))
                pubkeyId[r.pubkey] = Number(r.id);
        } finally { await conn.release(); }
    });

    after(async function () {
        if (db && db.pool) await db.pool.end();
    });

    // The fetch is fleet-wide, not round-scoped, so an undrained attestation from an
    // earlier case would re-enter every later fetch. Reset rather than renumber.
    beforeEach(reset);

    async function conn(fn) {
        const c = await db.getConnection();
        try { return await fn(c); } finally { await c.release(); }
    }

    async function reset() {
        await conn(async c => {
            for (const t of ['anchor_reward_attestations', 'validator_rewards',
                             'anchor_reward_reconcile_log'])
                await c.query('DELETE FROM ' + t);
        });
    }

    /** Mirror one hub-authored attestation in, as hub_db_sync does. */
    function attest(publisher, snapshotBlock) {
        return conn(c => c.query(
            `INSERT INTO anchor_reward_attestations
                 (chain, network, reward_type, round_reference, snapshot_block,
                  publisher, reward_amount, publisher_attestations)
             VALUES ('BTC', 'regtest', ?, ?, ?, ?, '100', '[]')`,
            [RTYPE, ROUND, (snapshotBlock === undefined ? SNAP : snapshotBlock), publisher]));
    }

    /** Credit the derived reward, as createValidatorReward does once the stake source resolves. */
    function credit(row) {
        return conn(c => c.query(
            `INSERT INTO validator_rewards
                 (source_id, signing_pubkey_id, reward_type, round_reference, amount, block_index)
             VALUES (?, ?, ?, ?, '100', ?)`,
            [SOURCE, pubkeyId[row.publisher], row.reward_type, row.round_reference, SNAP]));
    }

    /** Every pubkey currently credited for this round. One entry once reconcile has run. */
    async function winners() {
        const rows = await conn(c => c.query(
            `SELECT pk.pubkey FROM validator_rewards vr
               JOIN index_pubkeys pk ON pk.id = vr.signing_pubkey_id
              WHERE vr.reward_type = ? AND vr.round_reference = ?
              ORDER BY pk.pubkey`, [RTYPE, ROUND]));
        return rows.map(r => r.pubkey);
    }

    /** One derive pass: fetch through the gate, credit what it returned, reconcile. */
    async function derivePass(blockIndex) {
        const pending = await db.getPendingAnchorRewardAttestations('regtest', SNAP);
        for (const row of pending) await credit(row);
        await db.reconcileAnchorRewardWinner(ROUND, RTYPE, blockIndex, blockIndex);
        return pending.map(r => r.publisher);
    }

    it('returns every publisher of a round nothing has derived yet', async function () {
        await attest(PK_LARGE);
        await attest(PK_SMALL);
        const pending = await db.getPendingAnchorRewardAttestations('regtest', SNAP);
        assert.deepStrictEqual(pending.map(r => r.publisher).sort(), [PK_SMALL, PK_LARGE].sort());
    });

    it('re-admits a late failover publisher that would WIN, and reconcile promotes it', async function () {
        // The defect. The larger-pubkey publisher arrives first and is derived; the
        // smaller-pubkey one mirrors in afterwards. Under a round-scoped NOT EXISTS the
        // second fetch is empty, reconcile never sees the true winner, and this node keeps
        // a different winner (and credits a different staking source) from one that saw
        // both publishers in a single fetch.
        await attest(PK_LARGE);
        assert.deepStrictEqual(await derivePass(SNAP), [PK_LARGE]);
        assert.deepStrictEqual(await winners(), [PK_LARGE]);

        await attest(PK_SMALL);
        assert.deepStrictEqual(await derivePass(SNAP + 1), [PK_SMALL],
            'a late smaller-pubkey publisher must re-enter the fetch');
        assert.deepStrictEqual(await winners(), [PK_SMALL],
            'reconcile must collapse the round to the smallest pubkey');
    });

    it('does not re-admit a late publisher that would LOSE, so a settled round never re-derives', async function () {
        await attest(PK_SMALL);
        assert.deepStrictEqual(await derivePass(SNAP), [PK_SMALL]);

        await attest(PK_LARGE);
        assert.deepStrictEqual(await derivePass(SNAP + 1), [],
            'a publisher that sorts above the derived winner stays excluded');
        assert.deepStrictEqual(await winners(), [PK_SMALL]);
    });

    it('is self-terminating: once promoted, neither publisher is fetched again', async function () {
        await attest(PK_LARGE);
        await derivePass(SNAP);
        await attest(PK_SMALL);
        await derivePass(SNAP + 1);

        assert.deepStrictEqual(await derivePass(SNAP + 2), [],
            'the promoted winner excludes itself and the loser, so there is no churn');
        assert.deepStrictEqual(await winners(), [PK_SMALL]);
    });

    it('converges on the same winner whichever order the two publishers arrive in', async function () {
        // The property the whole fix exists for: two nodes that received the failover
        // publishers in opposite orders must agree, because validator_rewards is summed
        // into the COLLECT rail and the consensus ledger hash.
        await attest(PK_LARGE);
        await derivePass(SNAP);
        await attest(PK_SMALL);
        await derivePass(SNAP + 1);
        const largeFirst = await winners();

        await reset();
        await attest(PK_SMALL);
        await derivePass(SNAP);
        await attest(PK_LARGE);
        await derivePass(SNAP + 1);
        const smallFirst = await winners();

        assert.deepStrictEqual(largeFirst, smallFirst);
        assert.deepStrictEqual(largeFirst, [PK_SMALL]);
    });

    it('still withholds an attestation whose snapshot block has not matured', async function () {
        // The maturity gate is the other half of the WHERE clause; the new join must not
        // hand back a reward whose block_index would land in the future.
        await attest(PK_SMALL, SNAP + 50);
        const pending = await db.getPendingAnchorRewardAttestations('regtest', SNAP);
        assert.deepStrictEqual(pending, []);
    });
});
