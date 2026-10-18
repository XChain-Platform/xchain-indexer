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
 * test/unit/db/stakes/slash_historical_set.test.js
 *
 * The capability set read at a past height under slash_historical_set_activation. A SLASH
 * zeroes the burned stakes rows in place and logs each one in capability_slash_debits. Armed,
 * every set, weight, count and membership read at height h adds back the debits whose slash
 * block is above h, so a read at h before a slash answers the same after it, for an active
 * bond and for a cooling bond's residual row alike. Unarmed (the committed mainnet and testnet
 * rows, and regtest while its variable is unset) the reads sum the current amount. The reads
 * and the real slashCapabilityStake run on node:sqlite over the project's own DDL.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { getTestConfig }    = require('../../../fixtures/config');
const { mysqlDdlToSqlite } = require('../../../helpers/sqlAnchorDb.js');
const Utility              = require('../../../../src/utility');
const Database             = require('../../../../src/db');

const SQL_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql');
const ENV     = 'XC_SLASH_HISTORICAL_SET_REGTEST_ACTIVATION';
const CAP     = 'oracle_publish';
const TABLES  = ['index_statuses', 'index_addresses', 'index_pubkeys', 'stakes', 'unstakes', 'delegations',
                 'stake_key_revocations', 'capability_slash_debits', 'capability_slash_events'];
const P1 = '01'.repeat(32), P2 = '02'.repeat(32), P3 = '03'.repeat(32);
const P4 = '04'.repeat(32), PD = '0d'.repeat(32);

// One BTC chain, capability MIN_STAKE 500:
//   P1 (source 1) an active 1000 bond, slashed at block 40;
//   P2 (source 2) an active 1000 bond, never slashed;
//   P3 (source 3) staked 1000, UNSTAKE 400 at block 20 with a 6-block delay, so the 1000 row
//   deactivates at 26, the 600 residual row activates at 26 and 400 cools until 30; slashed at 28.
// With `delegated`, also P4 (source 4) an active 1000 bond whose source delegates key PD from
// block 12; a SLASH of PD burns source 4's bond, so P4 is its co-key.
function makeDb(network, delegated) {
    const { DatabaseSync } = require('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    for (const t of TABLES) {
        const ddl = fs.readFileSync(path.join(SQL_DIR, t + '.sql'), 'utf8').split('\n')
            .filter(l => !/^\s*CREATE\s+(UNIQUE\s+)?INDEX/i.test(l)).join('\n')
            .replace(/CHARACTER SET \w+ COLLATE \w+/gi, '').replace(/ENUM\([^)]*\)/gi, 'TEXT');
        sql.exec(mysqlDdlToSqlite(ddl));
    }
    for (const s of ['valid', 'pending']) sql.prepare('INSERT INTO index_statuses (status) VALUES (?)').run(s);
    for (const a of ['src1', 'src2', 'src3']) sql.prepare('INSERT INTO index_addresses (address) VALUES (?)').run(a);
    for (const p of [P1, P2, P3]) sql.prepare('INSERT INTO index_pubkeys (pubkey) VALUES (?)').run(p);
    const stake = sql.prepare('INSERT INTO stakes (action_index, source_id, version, signing_pubkey_id, amount, status_id, block_index, activation_block, deactivation_block) VALUES (?, ?, 1, ?, ?, 1, ?, ?, ?)');
    stake.run(10, 1, 1, '1000', 3, 3, null);
    stake.run(11, 2, 2, '1000', 3, 3, null);
    stake.run(12, 3, 3, '1000', 3, 3, 26);
    stake.run(20, 3, 3, '600', 20, 26, null);
    sql.prepare('INSERT INTO unstakes (action_index, source_id, signing_pubkey_id, cooldown_end_block, amount, status_id, block_index) VALUES (20, 3, 3, 30, ?, 1, 20)').run('400');
    if (delegated) {
        sql.prepare('INSERT INTO index_addresses (address) VALUES (?)').run('src4');
        for (const p of [P4, PD]) sql.prepare('INSERT INTO index_pubkeys (pubkey) VALUES (?)').run(p);
        stake.run(13, 4, 4, '1000', 3, 3, null);
        sql.prepare('INSERT INTO delegations (action_index, source_id, signing_pubkey_id, status_id, block_index, activation_block) VALUES (14, 4, 5, 1, 12, 12)').run();
    }

    const config = getTestConfig();
    config.NETWORK = network || 'regtest';
    config.STAKING = Object.assign({}, config.STAKING, { CAPABILITIES: { [CAP]: { MIN_STAKE: '500' } } });
    config.VALIDATOR_QUERY_LIMIT = config.VALIDATOR_QUERY_LIMIT || 1000;
    const util = new Utility(config);
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    // sqlite has no MariaDB collations; the ordering suffix does not change the set these rows produce.
    db.doQuery = async (q, args) => sql.prepare(q.replace(/ COLLATE \w+/g, '')).all(...(args || [])).map(r => Object.assign({}, r));
    return db;
}

// The SLASH handler's two writes: burn the bond, then record the event the set queries exclude by.
async function slash(db, pubkeyId, block, slashActionIndex, ownerSourceId) {
    const burned = await db.slashCapabilityStake(pubkeyId, block, slashActionIndex, true, ownerSourceId === undefined ? null : ownerSourceId);
    await db.doQuery(`INSERT INTO capability_slash_events (slash_action_index, signing_pubkey_id, capability, equiv_key, amount, block_index)
                      VALUES (?, ?, ?, ?, ?, ?)`, [slashActionIndex, pubkeyId, CAP, 'k' + slashActionIndex, burned.total, block]);
    return burned;
}

// Every capability read a quorum check resolves through, at height h.
async function reading(db, h) {
    const n = (v) => String(Number(v));
    return {
        set:     (await db.getValidatorsByCapability(CAP, h)).map(v => v.pubkey.slice(0, 2) + ':' + n(v.amount)),
        weights: (await db.getStakeWeightsByCapability(CAP, h)).map(v => v.pubkey.slice(0, 2) + ':' + n(v.weight)),
        count:   await db.getActiveCapabilityCount(CAP, h),
        has:     [await db.hasCapability(P1, CAP, h), await db.hasCapability(P2, CAP, h), await db.hasCapability(P3, CAP, h)],
    };
}

async function readings(db, heights) {
    const out = {};
    for (const h of heights) out[h] = await reading(db, h);
    return out;
}

describe('slash_historical_set_activation: armed, a past-height read is unchanged by a later SLASH @regression @tier1', function () {
    beforeEach(function () { process.env[ENV] = 'armed'; });
    afterEach(function () { delete process.env[ENV]; sinon.restore(); });

    it('an active bond slashed at 40 keeps its weight in every read below 40', async function () {
        const db = makeDb();
        const before = await readings(db, [15, 30, 39]);
        assert.deepStrictEqual(before[30].set, ['01:1000', '02:1000', '03:600']);
        assert.strictEqual((await slash(db, 1, 40, 400)).total, '1000');
        assert.deepStrictEqual(await readings(db, [15, 30, 39]), before);
    });

    it('a cooling bond slashed at 28 keeps its cooling row and its residual in every read below 28', async function () {
        const db = makeDb();
        const before = await readings(db, [15, 25, 27]);
        assert.deepStrictEqual(before[15].set, ['01:1000', '02:1000', '03:1000'], 'below 26 the swept row carries the bond');
        assert.deepStrictEqual(before[27].set, ['01:1000', '02:1000', '03:600'], 'from 26 the residual row carries it');
        assert.strictEqual((await slash(db, 3, 28, 280)).total, '1000', 'the residual 600 and the cooling 400 burn');
        assert.deepStrictEqual(await readings(db, [15, 25, 27]), before);
    });

    it('a delegated key slashed at 40 takes its source co-key out at 40, and below 40 both keep the bond', async function () {
        const db = makeDb('regtest', true);
        const before = await readings(db, [30, 39]);
        assert.deepStrictEqual(before[39].set, ['01:1000', '02:1000', '03:600', '04:1000', '0d:1000']);
        assert.strictEqual((await slash(db, 5, 40, 400, 4)).total, '1000');
        assert.deepStrictEqual(await readings(db, [30, 39]), before);
        // At the slash block the burn is in force: the debit recorded at 40 is not added back.
        const at = await reading(db, 40);
        assert.deepStrictEqual(at.set, ['01:1000', '02:1000', '03:600']);
        assert.deepStrictEqual(at.weights.filter(w => w.startsWith('04')), []);
        assert.strictEqual(await db.hasCapability(P4, CAP, 40), false);
        assert.strictEqual(await db.hasCapability(P4, CAP, 39), true);
    });

    it('a read at or above the slash block excludes the slashed key, as unarmed does', async function () {
        const armed = makeDb();
        await slash(armed, 1, 40, 400);
        const atAndAfter = await readings(armed, [40, 45]);
        delete process.env[ENV];
        const legacy = makeDb();
        await slash(legacy, 1, 40, 400);
        assert.deepStrictEqual(await readings(legacy, [40, 45]), atAndAfter);
        assert.deepStrictEqual(atAndAfter[40].set, ['02:1000', '03:600']);
    });

    it('a read with no later debit emits the add-back and answers what the unarmed read answers', async function () {
        const db = makeDb();
        const armed = await readings(db, [30]);
        assert.ok(db.effectiveCapabilitySetSql(1, 30, '500').sql.includes('capability_slash_debits'));
        delete process.env[ENV];
        assert.deepStrictEqual(await readings(db, [30]), armed);
    });
});

describe('slash_historical_set_activation: unarmed @regression @tier1', function () {
    afterEach(function () { delete process.env[ENV]; sinon.restore(); });

    it('is UNARMED on mainnet, armed on testnet from its v0.24.0 height, and UNPINNED on regtest, armed only by the variable', function () {
        const reg = require('../../../../src/consensus/gate_registry');
        const KEY = 'slash_historical_set_activation.SLASH_HISTORICAL_SET_ACTIVATION';
        // The v0.24.0 cut arms BTC:testnet at 156908; the probes below sit under it.
        for (const net of ['mainnet', 'testnet', 'regtest'])
            assert.strictEqual(reg.activeAt(KEY, net, 'BTC', net === 'testnet' ? 156907 : 5000000, null), false, net);
        assert.strictEqual(reg.activeAt(KEY, 'testnet', 'BTC', 156908, null), true, 'testnet at its height');
        process.env[ENV] = 'armed';
        assert.strictEqual(reg.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
        assert.strictEqual(reg.activeAt(KEY, 'mainnet', 'BTC', 5000000, null), false);
    });

    it('emits the committed set SQL with no add-back below activation', function () {
        for (const network of ['mainnet', 'testnet', 'regtest']) {
            const db = makeDb(network);
            const eff = db.effectiveCapabilitySetSql(1, 30, '500');
            assert.ok(!eff.sql.includes('capability_slash_debits'), network);
            assert.strictEqual(eff.args.length, 15, network);
            assert.deepStrictEqual(db.stakeWeightsAtSql(1, 30, '500'), db.stakeWeightsSql(1, 30, '500'), network);
        }
    });

    it('sums the current amount, so the slashed bond leaves the past-height read (mainnet, testnet, regtest unset)', async function () {
        for (const network of ['mainnet', 'testnet', 'regtest']) {
            const db = makeDb(network);
            await slash(db, 1, 40, 400);
            const r = await reading(db, 30);
            assert.deepStrictEqual(r.set, ['02:1000', '03:600'], network);
            assert.deepStrictEqual(r.has, [false, true, true], network);
        }
    });
});
