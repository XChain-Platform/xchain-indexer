/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * test/unit/anchor/anchor_reward_derive.test/copy_selection.test.js
 *
 * Copies of one signed anchor reward tuple under anchor_reward_copy_selection_activation.
 * doge_anchor_txid and publisher_attestations sit outside the XANCPUB canonical, so a tuple
 * can arrive as copies that differ in either. The mirror keeps the first copy in
 * anchor_reward_attestations and records every copy in anchor_reward_attestation_copies
 * (the apply and the read run on node:sqlite over the project's own DDL). Armed, the derive
 * pass mints a tuple from whichever copy meets quorum and proves, the same way for either
 * arrival order; unarmed, the kept first copy decides.
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
const derive               = require('../../../../src/consensus/anchor_reward_derive.js');
const selection            = require('../../../../src/consensus/anchor_reward_derive/copy_selection.js');
const { AnchorProofUnavailableError } = require('../../../../src/consensus/anchor_reward_derive/mint_row.js');
const { mirrorUpsertSql }  = require('../../../../src/hub/hub_db_sync/row_upserts.js');
const { copyInsert, copyDigest } = require('../../../../src/hub/hub_db_sync/apply/attestation_copies.js');
const gateRegistry         = require('../../../../src/consensus/gate_registry');

const SQL_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql');
const ENV     = 'XC_ANCHOR_REWARD_COPY_SELECTION_REGTEST_ACTIVATION';
const KEY     = 'anchor_reward_copy_selection_activation.ANCHOR_REWARD_COPY_SELECTION_ACTIVATION';
const PUB     = 'ab'.repeat(32);
const GOOD    = '11'.repeat(32), ABSENT = '22'.repeat(32), OTHER = '00'.repeat(32);
const SIGS4   = JSON.stringify([1, 2, 3, 4].map(i => ({ pubkey: String(i).repeat(64), sig: 's' + i })));
const SIGS2   = JSON.stringify([1, 2].map(i => ({ pubkey: String(i).repeat(64), sig: 's' + i })));

function row(txid, sigs) {
    return { chain: 'DOGE', network: 'regtest', reward_type: 'anchor_bundle', round_reference: 20, snapshot_block: 20,
             publisher: PUB, reward_amount: '10', publisher_attestations: sigs, doge_anchor_txid: txid };
}

// A Database on node:sqlite holding the two mirror tables and the reward tables the
// pending reads join, with `copies` applied in order exactly as applyRow writes them.
function mirrorDb(copies) {
    const { DatabaseSync } = require('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    for (const t of ['anchor_reward_attestations', 'anchor_reward_attestation_copies', 'validator_rewards', 'index_pubkeys']) {
        const ddl = fs.readFileSync(path.join(SQL_DIR, t + '.sql'), 'utf8').split('\n')
            .filter(l => !/^\s*CREATE\s+(UNIQUE\s+)?INDEX/i.test(l)).join('\n')
            .replace(/CHARACTER SET \w+ COLLATE \w+/gi, '')
            // sqlite takes an inline UNIQUE constraint unnamed and no inline plain KEY.
            .replace(/UNIQUE KEY \w+ \(/gi, 'UNIQUE (').replace(/,\s*\n\s*KEY \w+ \([^)]*\)/gi, '');
        sql.exec(mysqlDdlToSqlite(ddl));
    }
    const run = (q, args) => sql.prepare(q.replace(/^INSERT IGNORE/, 'INSERT OR IGNORE')).run(...args);
    for (const r of copies) {
        const cols = Object.keys(r);
        run(mirrorUpsertSql('anchor_reward_attestations', cols, cols.map(() => '?').join(', ')), cols.map(c => r[c]));
        const ci = copyInsert(r);
        run(ci.sql, ci.args);
    }
    const config = getTestConfig();
    const util = new Utility(config);
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    db.doQuery = async (q, args) => sql.prepare(q).all(...(args || [])).map(r => Object.assign({}, r));
    return db;
}

// A proof client whose verdict is a function of the txid alone: GOOD is mined, OTHER names
// another reward's anchor, ABSENT is not visible.
const proof = { proveMined: async (e) => (e.txid === GOOD ? 'verified' : e.txid === OTHER ? 'rejected' : 'unknown') };
// The quorum check stands in for verifyAttestation: four signers meet it, two do not.
const quorum = async (db, r) => JSON.parse(r.publisher_attestations).length >= 3;

function context(minted) {
    return {
        indexerDb: { createValidatorReward: async (...a) => { minted.push(a); return true; } },
        gatesActive: () => true, verifyAttestation: quorum,
        mint: { blockIndex: 164, proof, minConfirmations: 60, amount: '10', legacyAnchorRewardPin: false },
    };
}

describe('anchor reward copies: the mirror keeps every copy @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('keeps the first copy in the main table and every distinct copy beside it, in either order', async function () {
        for (const order of [[row(ABSENT, SIGS4), row(GOOD, SIGS4)], [row(GOOD, SIGS4), row(ABSENT, SIGS4)]]) {
            const db = mirrorDb(order.concat([order[0]]));
            const kept = await db.getPendingAnchorRewardAttestations('regtest', 20);
            assert.deepStrictEqual(kept.map(r => r.doge_anchor_txid), [order[0].doge_anchor_txid]);
            const tuples = selection.copiesByTuple(await db.getPendingAnchorRewardAttestationCopies('regtest', 20));
            assert.deepStrictEqual(tuples.map(t => t.map(c => c.doge_anchor_txid)), [[GOOD, ABSENT]]);
        }
    });

    it('names a copy by its txid and attestation list only', function () {
        assert.strictEqual(copyDigest(row(GOOD, SIGS4)), copyDigest(Object.assign(row(GOOD, SIGS4), { chain: 'BTC' })));
        assert.notStrictEqual(copyDigest(row(GOOD, SIGS4)), copyDigest(row(GOOD, SIGS2)));
        assert.notStrictEqual(copyDigest(row(GOOD, SIGS4)), copyDigest(row(null, SIGS4)));
    });
});

describe('anchor reward copies: armed selection @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    for (const [name, bad] of [['an absent txid', row(ABSENT, SIGS4)], ['another anchor txid', row(OTHER, SIGS4)], ['a short signature list', row(GOOD, SIGS2)]]) {
        it('mints once from the proven copy whichever arrived first: ' + name, async function () {
            for (const order of [[bad, row(GOOD, SIGS4)], [row(GOOD, SIGS4), bad]]) {
                const minted = [];
                const [copies] = selection.copiesByTuple(order);
                const chosen = await selection.mintTuple(copies, context(minted));
                assert.strictEqual(chosen.doge_anchor_txid, GOOD);
                assert.strictEqual(minted.length, 1);
                assert.deepStrictEqual(minted[0].slice(0, 5), [PUB, 20, 'anchor_bundle', '10', 20]);
            }
        });
    }

    it('defers while no copy proves and one is undecided, and pays nothing when every copy is rejected', async function () {
        const minted = [];
        const [undecided] = selection.copiesByTuple([row(OTHER, SIGS4), row(ABSENT, SIGS4)]);
        await assert.rejects(selection.mintTuple(undecided, context(minted)), AnchorProofUnavailableError);
        const [rejected] = selection.copiesByTuple([row(OTHER, SIGS4), row(GOOD, SIGS2)]);
        assert.strictEqual(await selection.mintTuple(rejected, context(minted)), null);
        assert.strictEqual(minted.length, 0);
    });
});

describe('anchor reward copies: the derive pass and its gate @regression @tier1', function () {
    afterEach(function () { delete process.env[ENV]; sinon.restore(); });

    it('is UNARMED on mainnet and testnet and UNPINNED on regtest, armed only by the variable', function () {
        for (const net of ['mainnet', 'testnet', 'regtest'])
            assert.strictEqual(gateRegistry.activeAt(KEY, net, 'BTC', 5000000, null), false, net);
        process.env[ENV] = 'armed';
        assert.strictEqual(gateRegistry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
        assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', 'BTC', 5000000, null), false);
    });

    it('reads the kept rows unarmed and every copy armed', async function () {
        for (const armed of [false, true]) {
            if (armed) process.env[ENV] = 'armed'; else delete process.env[ENV];
            const db = {
                getPendingAnchorRewardAttestations: sinon.stub().resolves([]),
                getPendingAnchorRewardAttestationCopies: sinon.stub().resolves([]),
            };
            await derive.deriveAnchorRewards(db, { COIN: 'BTC', NETWORK: 'regtest' }, 200, proof);
            assert.strictEqual(db.getPendingAnchorRewardAttestations.called, !armed);
            assert.strictEqual(db.getPendingAnchorRewardAttestationCopies.called, armed);
        }
    });
});
