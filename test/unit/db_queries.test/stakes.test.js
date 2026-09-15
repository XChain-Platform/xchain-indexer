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
 * test/unit/db_queries.test/stakes.test.js
 *
 * Pubkey methods and the direct-stake views: active validators, the active
 * stake by pubkey in all three modes, the effective stake, and stake
 * deactivation.
 *
 * Part of the Database query suite (see ../db_queries.test.js): real method
 * logic against a stubbed doQuery, no live MariaDB required.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb, dbWithDoQuery } = require('./helpers/db_stub');

afterEach(function () {
    sinon.restore();
});

// ---------------------------------------------------------------------------
// getPubkeyId / getOrCreatePubkeyId
// ---------------------------------------------------------------------------
describe('Database pubkey methods @regression @tier1', function () {
    it('getPubkeyId returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getPubkeyId('deadbeef'), null);
    });

    it('getPubkeyId returns numeric id on hit', async function () {
        const db = dbWithDoQuery([{ id: 8 }]);
        assert.strictEqual(await db.getPubkeyId('deadbeef'), 8);
    });

    it('getOrCreatePubkeyId returns null for null pubkey', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getOrCreatePubkeyId(null), null);
    });

    it('getOrCreatePubkeyId normalizes to lowercase and truncates to 64 chars', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([]);
        stub.onCall(1).resolves([]);
        stub.onCall(2).resolves([{ id: 1 }]);
        const long = 'ABCDEF1234567890'.repeat(10); // 160 chars uppercase
        await db.getOrCreatePubkeyId(long);
        const insertArgs = stub.getCall(1).args[1];
        assert.strictEqual(insertArgs[0], long.toLowerCase().substring(0, 64));
    });

    it('getOrCreatePubkeyId returns existing id', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ id: 17 }]);
        assert.strictEqual(await db.getOrCreatePubkeyId('aabbcc'), 17);
    });
});

// ---------------------------------------------------------------------------
// createPubkey
// ---------------------------------------------------------------------------
describe('Database.createPubkey() @regression @tier1', function () {
    it('does nothing when address_id is falsy', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        await db.createPubkey(null, 'deadbeef'); // should not throw
        assert.strictEqual(db.doQuery.callCount, 0);
    });

    it('does nothing when pubkey is falsy', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        await db.createPubkey(1, null);
        assert.strictEqual(db.doQuery.callCount, 0);
    });

    it('calls INSERT IGNORE when both arguments provided', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        await db.createPubkey(5, 'deadbeef');
        assert.match(db.doQuery.firstCall.args[0], /INSERT IGNORE INTO pubkeys/i);
    });
});

// ---------------------------------------------------------------------------
// getActiveValidators
// ---------------------------------------------------------------------------
describe('Database.getActiveValidators() @regression @tier1', function () {
    it('returns [] when valid status not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').resolves(null);
        const result = await db.getActiveValidators(100);
        assert.deepStrictEqual(result, []);
    });

    it('returns mapped pubkey/amount objects', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([
            { pubkey: 'aabbcc', total: '10000' },
            { pubkey: 'ddeeff', total: null }
        ]);
        const result = await db.getActiveValidators(500);
        assert.deepStrictEqual(result[0], { pubkey: 'aabbcc', amount: '10000' });
        assert.deepStrictEqual(result[1], { pubkey: 'ddeeff', amount: '0' });
    });

    it('returns [] when doQuery returns empty', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').resolves(2);
        sinon.stub(db, 'doQuery').resolves([]);
        const empty = await db.getActiveValidators(100);
        assert.deepStrictEqual([...empty], []);
        assert.strictEqual(empty.truncated, false);
    });
});

// ---------------------------------------------------------------------------
// getActiveStakeByPubkey
// ---------------------------------------------------------------------------
describe('Database.getActiveStakeByPubkey() @regression @tier1', function () {
    it('returns null when pubkey not found in index_pubkeys', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        assert.strictEqual(await db.getActiveStakeByPubkey('deadbeef', 100), null);
    });

    it('returns null when no stake rows found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getActiveStakeByPubkey('deadbeef', 100), null);
    });

    it('returns stake object with amount coerced to string', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([{
            source_id:         10,
            signing_pubkey_id: 3,
            signing_pubkey:    'deadbeef',
            amount:            '50000.00000000',
            activation_block:  100,
            block_index:       100,
            status_id:         1
        }]);
        const stake = await db.getActiveStakeByPubkey('deadbeef', 200);
        assert.strictEqual(stake.amount, '50000.00000000');
        assert.strictEqual(stake.signing_pubkey, 'deadbeef');
    });

    it('returns amount "0" when row.amount is null', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([{
            source_id: 1, signing_pubkey_id: 3, signing_pubkey: 'pk',
            amount: null, activation_block: 0, block_index: 0, status_id: 1
        }]);
        const stake = await db.getActiveStakeByPubkey('pk', 100);
        assert.strictEqual(stake.amount, '0');
    });
});

describe('Database.getActiveStakeByPubkey() @regression @tier1', function () {
    it('includes blockIndex filter args when blockIndex is provided', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery').resolves([]);
        await db.getActiveStakeByPubkey('pk', 500);
        const args = q.firstCall.args[1];
        // Should include blockIndex (500) twice
        assert.ok(args.includes(500));
    });

    it('omits blockIndex filter when blockIndex is null', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery').resolves([]);
        await db.getActiveStakeByPubkey('pk', null);
        const args = q.firstCall.args[1];
        // Direct-stake-only (stake-ownership) view: without blockIndex the args are just
        // [pubkey_id, valid_id]. No revocation NOT EXISTS subquery and no activation/deactivation
        // range filter (that only fires when blockIndex is non-null).
        assert.strictEqual(args.length, 2);
    });
});

describe('Database.getActiveStakeByPubkey() @regression @tier1', function () {
    // STAKE v1 key-reuse mode (src/stake_key_reuse_activation.js). These cases pin the
    // SQL TEXT and the bind args; the verdicts that SQL produces are driven at the action
    // layer in test/unit/actions/stake/stake_key_reuse.test.js, and the two halves are written
    // to be read together.
    describe('reuseBlockingOnly mode', function () {
        async function capture(blockIndex) {
            const db = makeDb();
            sinon.stub(db, 'getPubkeyId').resolves(3);
            sinon.stub(db, 'getStatusId').resolves(1);
            const q = sinon.stub(db, 'doQuery').resolves([]);
            await db.getActiveStakeByPubkey('pk', blockIndex, { reuseBlockingOnly: true });
            return { sql: q.firstCall.args[0], args: q.firstCall.args[1], db };
        }

        it('applies NO activation_block filter, so a pending-activation row still counts', async function () {
            // This is the whole reason the mode exists. Both other modes carry
            // `activation_block <= ?`, which hides a row staked inside its
            // ACTIVATION_DELAY_BLOCKS window and would let one key carry two bonds.
            const { sql } = await capture(500);
            assert.ok(!/activation_block\s*<=/.test(sql),
                'the reuse predicate must not filter on activation_block: ' + sql);
        });

        it('excludes only rows deactivated AND past cooldown', async function () {
            const { sql } = await capture(500);
            assert.ok(/AND \(s\.deactivation_block IS NULL OR s\.deactivation_block \+ \? > \?\)/.test(sql),
                'expected the cooldown clause on the stakes row: ' + sql);
        });

        it('binds COOLDOWN_BLOCKS from config and then the block being parsed, in that order', async function () {
            const { sql, args, db } = await capture(500);
            const cooldown = db.config['STAKING']['COOLDOWN_BLOCKS'];
            assert.ok(Number.isFinite(cooldown) && cooldown > 0, 'config must carry COOLDOWN_BLOCKS');
            // Order matters: reversed, the clause reads deactivation_block + blockIndex >
            // cooldown, which frees a key the instant it is deactivated.
            assert.deepStrictEqual(args, [3, 1, cooldown, 500]);
            // The bind order above is only meaningful against the clause above it.
            assert.ok(sql.indexOf('s.deactivation_block + ?') < sql.indexOf('GROUP BY'));
        });
    });
});

describe('Database.getActiveStakeByPubkey() @regression @tier1', function () {
    describe('reuseBlockingOnly mode', function () {
        it('does not disturb the other two modes', async function () {
            const db = makeDb();
            sinon.stub(db, 'getPubkeyId').resolves(3);
            sinon.stub(db, 'getStatusId').resolves(1);
            const q = sinon.stub(db, 'doQuery').resolves([]);

            await db.getActiveStakeByPubkey('pk', 500, { undeactivatedOnly: true });
            assert.ok(/AND s\.activation_block <= \? AND s\.deactivation_block IS NULL/.test(q.firstCall.args[0]));
            assert.deepStrictEqual(q.firstCall.args[1], [3, 1, 500]);

            await db.getActiveStakeByPubkey('pk', 500);
            assert.ok(/AND s\.activation_block <= \? AND \(s\.deactivation_block IS NULL OR s\.deactivation_block > \?\)/
                        .test(q.secondCall.args[0]));
            assert.deepStrictEqual(q.secondCall.args[1], [3, 1, 500, 500]);
        });

        it('is inert without a blockIndex, so the legacy null call cannot reach it', async function () {
            // The mode lives inside the non-null blockIndex branch. A caller that passed
            // the flag with a null block would otherwise get a cooldown clause bound
            // against null, which in SQL is never true and would admit every key.
            const { args } = await (async () => {
                const db = makeDb();
                sinon.stub(db, 'getPubkeyId').resolves(3);
                sinon.stub(db, 'getStatusId').resolves(1);
                const q = sinon.stub(db, 'doQuery').resolves([]);
                await db.getActiveStakeByPubkey('pk', null, { reuseBlockingOnly: true });
                return { args: q.firstCall.args[1] };
            })();
            assert.strictEqual(args.length, 2);
        });
    });

    it('does NOT resolve a delegated-only key (returns null when no direct stake row)', async function () {
        // Stake-ownership view must stay direct-stake-only: a key with no rows in `stakes`
        // returns null even if it holds a delegation. This is the consensus guard that keeps
        // a delegated-only key out of UNSTAKE/STAKE/DELEGATE (no Path 2 here).
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(7);
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getActiveStakeByPubkey('delegonly', 100), null);
        // Exactly one query (the direct-stake path); no delegated fallback query.
        assert.strictEqual(q.callCount, 1);
    });
});

// ---------------------------------------------------------------------------
// getEffectiveStakeByPubkey (federation effective-set view; getownstake RPC only)
// ---------------------------------------------------------------------------
describe('Database.getEffectiveStakeByPubkey() @regression @tier1', function () {
    it('returns null when pubkey not found in index_pubkeys', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        assert.strictEqual(await db.getEffectiveStakeByPubkey('deadbeef', 100), null);
    });

    it('returns the direct-stake row (Path 1) when present', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery').resolves([{
            source_id: 10, signing_pubkey_id: 3, signing_pubkey: 'pk',
            amount: '5000.00000000', activation_block: 100, block_index: 100, status_id: 1
        }]);
        const stake = await db.getEffectiveStakeByPubkey('pk', 200);
        assert.strictEqual(stake.amount, '5000.00000000');
        assert.strictEqual(q.callCount, 1);   // Path 1 hit, no delegated fallback
    });

    it('falls back to the delegating source aggregate (Path 2) for a delegated-only key', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(8);
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery');
        q.onCall(0).resolves([]);                                   // no direct stake (Path 1 empty)
        q.onCall(1).resolves([{                                     // delegated -> source aggregate
            source_id: 42, signing_pubkey_id: 8, signing_pubkey: 'delegkey',
            amount: '9000.00000000', activation_block: 50, block_index: 50, status_id: 1
        }]);
        const stake = await db.getEffectiveStakeByPubkey('delegkey', 200);
        assert.strictEqual(stake.amount, '9000.00000000');
        assert.strictEqual(stake.source_id, 42);
        assert.strictEqual(q.callCount, 2);   // Path 1 then Path 2
    });

    it('returns null when neither a direct stake nor a delegation resolves', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(9);
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery');
        q.onCall(0).resolves([]);
        q.onCall(1).resolves([]);
        assert.strictEqual(await db.getEffectiveStakeByPubkey('orphan', 200), null);
    });
});

// ---------------------------------------------------------------------------
// setStakeDeactivationByPubkey
// ---------------------------------------------------------------------------
describe('Database.setStakeDeactivationByPubkey() @regression @tier1', function () {
    it('returns false when pubkey not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        assert.strictEqual(await db.setStakeDeactivationByPubkey('pk', 600), false);
    });

    it('returns true and runs UPDATE when pubkey found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(5);
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.setStakeDeactivationByPubkey('pk', 600);
        assert.strictEqual(result, true);
        assert.match(db.doQuery.firstCall.args[0], /UPDATE stakes/i);
    });
});
