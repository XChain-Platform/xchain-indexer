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
 *********************************************************************/

// The remote-token pin read and its accept call shape either side of
// remote_token_admission_activation.

process.env.INDEXER_COIN = 'LTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const gateRegistry = require('../../../src/consensus/gate_registry');
const mixin = require('../../../src/db/list_share_mirrors/index.js');
const connections = require('../../../src/db/database/connections.js');
const { rethrowIfInfraFault } = require('../../../src/consensus/fault_guard.js');
const { remoteTokenAcceptError, REMOTE_TOKEN_KEY, REMOTE_TOKEN_ADMISSION_KEY } =
    require('../../../src/actions/cross_chain_remote_token');
const { signedRemoteTokenRow, stubRemoteTokenValidators } = require('../../fixtures/mocks');

const PRESENCE_SQL = "SELECT * FROM remote_token_snapshots WHERE status = 'finalized' AND network = ? AND coin = ? AND tick = ? ORDER BY snapshot_block DESC, source_action_index DESC, snapshot_id DESC LIMIT 1";
const admittedSql = (c) => "SELECT * FROM remote_token_snapshots WHERE status = 'finalized' AND network = ? AND coin = ? AND tick = ? AND admit_block_" + c + ' IS NOT NULL AND admit_block_' + c + " <= ? ORDER BY snapshot_block DESC, source_action_index DESC, snapshot_id DESC LIMIT 1";

function bindMixin(responses, indexer){
    const calls = [];
    const queue = (responses || []).slice();
    const query = async (sql, args) => {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), args });
        return queue.length > 0 ? queue.shift() : [];
    };
    const db = { doQuery: query, doQueryStrict: query, indexer: indexer || null,
                 util: { throwError(e){ throw (e instanceof Error ? e : new Error(e)); } } };
    for(const method of Reflect.ownKeys(mixin)) db[method] = mixin[method].bind(db);
    db.assertRemoteTokenBarrierNotSkipped = connections.assertRemoteTokenBarrierNotSkipped.bind(db);
    return { db, calls };
}

describe('remote-token admitted pin read @regression @tier1', function () {

    it('keeps the presence read byte for byte when no admission is passed', async function () {
        const { db, calls } = bindMixin([[]]);
        assert.strictEqual(await db.getPinnedRemoteToken('testnet', 'btc', 'XT'), null);
        assert.deepStrictEqual(calls, [{ sql: PRESENCE_SQL, args: ['testnet', 'BTC', 'XT'] }]);
    });

    for (const chain of ['BTC', 'LTC', 'DOGE']) {
        it('binds the read to admit_block_' + chain.toLowerCase() + ' at or below the block', async function () {
            const row = { snapshot_id: 'a'.repeat(64) };
            const { db, calls } = bindMixin([[row]]);
            assert.strictEqual(await db.getPinnedRemoteToken('regtest', 'btc', 'XT', { chain, height: 77 }), row);
            assert.deepStrictEqual(calls, [{ sql: admittedSql(chain.toLowerCase()), args: ['regtest', 'BTC', 'XT', 77] }]);
        });
    }

    it('refuses an admission it cannot bind rather than reading unbound', async function () {
        const { db, calls } = bindMixin([]);
        await assert.rejects(db.getPinnedRemoteToken('regtest', 'BTC', 'XT', { chain: 'XYZ', height: 1 }), /unusable admission/);
        await assert.rejects(db.getPinnedRemoteToken('regtest', 'BTC', 'XT', { chain: 'LTC', height: -1 }), /unusable admission/);
        await assert.rejects(db.getPinnedRemoteToken('regtest', 'BTC', 'XT', { chain: 'LTC', height: 'x' }), /unusable admission/);
        assert.strictEqual(calls.length, 0);
    });

    it('fails a barrier-skipped block closed at the admitted read and forces its retry to wait', async function () {
        const indexer = { remoteTokenBarrierSkipped: true, remoteTokenBarrierBlock: 900, remoteTokenBarrierForceBlock: null };
        const { db, calls } = bindMixin([[]], indexer);
        const owner = { _txEpoch: 1 };
        const err = await connections.runInTxEpoch.call(owner, 1, () =>
            db.getPinnedRemoteToken('regtest', 'BTC', 'XT', { chain: 'LTC', height: 900 })).catch(e => e);
        assert.strictEqual(err.code, 'REMOTE_TOKEN_BARRIER_DEFERRED');
        assert.strictEqual(indexer.remoteTokenBarrierForceBlock, 900);
        assert.strictEqual(calls.length, 0);
        assert.throws(() => rethrowIfInfraFault(err), (e) => e === err, 'the accept catch must not swallow it');
    });

    it('lets a read outside block processing through a skipped block', async function () {
        const indexer = { remoteTokenBarrierSkipped: true, remoteTokenBarrierBlock: 900 };
        const { db } = bindMixin([[]], indexer);
        assert.strictEqual(await db.getPinnedRemoteToken('regtest', 'BTC', 'XT', { chain: 'LTC', height: 900 }), null);
    });
});

describe('remote-token accept call shape either side of the admission activation @regression @tier2', function () {
    afterEach(() => sinon.restore());

    function handler(pinned){
        const getPinnedRemoteToken = sinon.stub().resolves(pinned);
        return { getPinnedRemoteToken, h: {
            config: { NETWORK: 'regtest', COIN: 'LTC' },
            util: { isNull: (v) => v === undefined || v === null || v === '' },
            indexerDb: stubRemoteTokenValidators({ mirrorDb: () => ({ getPinnedRemoteToken }) }),
        } };
    }
    const state = () => ({ format: 0, error: false, isCrossChain: true,
        data: { GET_COIN: 'BTC', GET_TICK: 'XT', BLOCK_INDEX: 321, BLOCK_TIME: 1 } });
    function stubGates(admission){
        const activeAt = gateRegistry.activeAt;
        sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
            key === REMOTE_TOKEN_KEY ? true : key === REMOTE_TOKEN_ADMISSION_KEY ? admission(...args) : activeAt(key, ...args));
    }

    it('reads by presence with the three-argument call while the activation is unarmed', async function () {
        stubGates(() => false);
        const { h, getPinnedRemoteToken } = handler(signedRemoteTokenRow({ network: 'mainnet' }));
        assert.strictEqual(await remoteTokenAcceptError(h, state()), null);
        assert.deepStrictEqual(getPinnedRemoteToken.firstCall.args, ['regtest', 'BTC', 'XT']);
    });

    it('reads the pin admitted on this chain at the create block once armed', async function () {
        stubGates((network, coin, height) => coin === 'LTC' && height >= 300);
        const { h, getPinnedRemoteToken } = handler(null);
        assert.strictEqual(await remoteTokenAcceptError(h, state()), 'invalid: GET_TICK (no pinned remote token)');
        assert.deepStrictEqual(getPinnedRemoteToken.firstCall.args, ['regtest', 'BTC', 'XT', { chain: 'LTC', height: 321 }]);
    });

    it('checks the consumer activation with this chain and the create block', async function () {
        const seen = [];
        stubGates((network, coin, height) => { seen.push([network, coin, height]); return false; });
        const { h } = handler(null);
        await remoteTokenAcceptError(h, state());
        assert.deepStrictEqual(seen[0], ['regtest', 'LTC', 321]);
    });
});

describe('remote_token_admission_activation registry row @regression @tier1', function () {
    const ARM = 'XC_REMOTE_TOKEN_ADMISSION_REGTEST_ACTIVATION';
    const active = (network, coin, h) => gateRegistry.activeAt(REMOTE_TOKEN_ADMISSION_KEY, network, coin, h, null);
    afterEach(() => { delete process.env[ARM]; });

    it('is unarmed on mainnet at every height and armed on testnet from its v0.24.0 height, whatever the regtest variable says', function () {
        // The v0.24.0 cut arms testnet per chain; the hub reads the bare key at the BTC height.
        const TESTNET = { null: 156908, BTC: 156908, LTC: 4927400, DOGE: 68005165 };
        for (const value of [undefined, 'armed', '0'])
            for (const coin of [null, 'BTC', 'LTC', 'DOGE']) {
                if (value === undefined) delete process.env[ARM]; else process.env[ARM] = value;
                for (const h of [0, 1, 5000000, 9999999998])
                    assert.strictEqual(active('mainnet', coin, h), false, 'mainnet ' + coin + ' ' + h + ' ' + value);
                assert.strictEqual(active('testnet', coin, TESTNET[String(coin)] - 1), false, 'testnet ' + coin + ' below ' + value);
                assert.strictEqual(active('testnet', coin, TESTNET[String(coin)]), true, 'testnet ' + coin + ' at ' + value);
            }
    });

    it('leaves regtest unarmed unless the venue sets the variable', function () {
        delete process.env[ARM];
        for (const coin of [null, 'BTC', 'LTC', 'DOGE']) assert.strictEqual(active('regtest', coin, 9999999998), false, coin);
        for (const value of ['', 'off', 'none', 'later']) {
            process.env[ARM] = value;
            assert.strictEqual(active('regtest', 'LTC', 9999999998), false, value);
        }
    });

    it('arms regtest from genesis on "armed" and from a height on a number', function () {
        process.env[ARM] = 'armed';
        for (const coin of [null, 'BTC', 'LTC', 'DOGE']) assert.strictEqual(active('regtest', coin, 0), true, coin);
        process.env[ARM] = '40';
        assert.strictEqual(active('regtest', 'LTC', 39), false);
        assert.strictEqual(active('regtest', 'LTC', 40), true);
    });
});
