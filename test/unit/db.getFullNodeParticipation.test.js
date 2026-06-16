/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db.getFullNodeParticipation.test.js
 *
 * Full-node REWARD participation inputs (carrot, not stick — no slashing). Over the
 * trailing FULLNODE.REWARD_PASS_WINDOW_BLOCKS, getFullNodeParticipation returns the
 * number of DISTINCT challenge epochs that produced a passing verdict (the denominator
 * — only epochs the federation actually ran), and per staking SOURCE the DISTINCT
 * epochs it answered plus its passing pubkeys. price.js gates the tranche on
 * passed_epochs/totalEpochs >= MIN_PASS_RATE_BPS/10000 (integer math). DB is stubbed
 * (no MariaDB) — runs on any Node.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const PK_C = 'c'.repeat(64);

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    return db;
}

// Stub doQuery: the COUNT(DISTINCT epoch_height) query returns `epochs`; the JOIN
// query returns the per-(source,epoch,pubkey) verdict rows.
function wire(db, { epochs, rows = [] }) {
    sinon.stub(db, 'doQuery').callsFake(async (sql) => {
        if (/COUNT\(DISTINCT\s+epoch_height\)/i.test(sql)) return [{ epochs }];
        if (/JOIN\s+index_pubkeys/i.test(sql))             return rows;
        return [];
    });
}

afterEach(() => sinon.restore());

describe('db.getFullNodeParticipation', function () {

    it('returns the distinct-epoch denominator and per-source passed_epochs + pubkeys', async function () {
        const db = makeDb();
        // 3 epochs ran. Source 1 (addrA) passed epochs 144 & 288 via key A; source 2
        // (addrB) passed epoch 432 via key B.
        wire(db, { epochs: 3, rows: [
            { source_id: 1, source: 'addrA', epoch_height: 144, pubkey: PK_A },
            { source_id: 1, source: 'addrA', epoch_height: 288, pubkey: PK_A },
            { source_id: 2, source: 'addrB', epoch_height: 432, pubkey: PK_B },
        ]});
        const part = await db.getFullNodeParticipation(1000);
        assert.strictEqual(part.totalEpochs, 3);
        assert.strictEqual(part.sources.length, 2);
        const s1 = part.sources.find(s => String(s.source_id) === '1');
        const s2 = part.sources.find(s => String(s.source_id) === '2');
        assert.strictEqual(s1.passed_epochs, 2);
        assert.deepStrictEqual(Array.from(s1.pubkeys).sort(), [PK_A]);
        assert.strictEqual(s2.passed_epochs, 1);
        assert.deepStrictEqual(Array.from(s2.pubkeys).sort(), [PK_B]);
    });

    it('counts an epoch once per source even if two of its keys passed it', async function () {
        const db = makeDb();
        // One source, one epoch, two distinct keys both passed → passed_epochs = 1,
        // pubkeys = {A, C}. (Delegated keys must not inflate the participation rate.)
        wire(db, { epochs: 5, rows: [
            { source_id: 7, source: 'addrShared', epoch_height: 144, pubkey: PK_A },
            { source_id: 7, source: 'addrShared', epoch_height: 144, pubkey: PK_C },
        ]});
        const part = await db.getFullNodeParticipation(1000);
        assert.strictEqual(part.totalEpochs, 5);
        assert.strictEqual(part.sources.length, 1);
        assert.strictEqual(part.sources[0].passed_epochs, 1, 'distinct epoch counted once');
        assert.deepStrictEqual(Array.from(part.sources[0].pubkeys).sort(), [PK_A, PK_C].sort());
    });

    it('returns empty (no sources) when no challenge epoch produced a verdict', async function () {
        const db = makeDb();
        // totalEpochs = 0 short-circuits: the federation was down / dormant this window,
        // so nobody is penalized and the per-source query is never relied on.
        wire(db, { epochs: 0, rows: [
            { source_id: 1, source: 'addrA', epoch_height: 144, pubkey: PK_A },
        ]});
        const part = await db.getFullNodeParticipation(1000);
        assert.strictEqual(part.totalEpochs, 0);
        assert.deepStrictEqual(part.sources, []);
    });

    it('returns empty when the reward-pass window is non-positive (feature off)', async function () {
        const db = makeDb();
        db.config.FULLNODE = Object.assign({}, db.config.FULLNODE, { REWARD_PASS_WINDOW_BLOCKS: 0, PROOF_WINDOW_BLOCKS: 0 });
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const part = await db.getFullNodeParticipation(1000);
        assert.strictEqual(part.totalEpochs, 0);
        assert.deepStrictEqual(part.sources, []);
        assert.ok(dq.notCalled, 'no query when the window is non-positive');
    });
});
