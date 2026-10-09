// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The remote token accept check shared by ORDER and SWAP creates.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const gateRegistry = require('../../../src/consensus/gate_registry');
const { remoteTokenAcceptError, REMOTE_TOKEN_KEY } = require('../../../src/actions/cross_chain_remote_token');
const orderValidate = require('../../../src/actions/order/validate');
const swapValidate  = require('../../../src/actions/swap/validate');

function makeHandler(pinned) {
    const getPinnedRemoteToken = sinon.stub().resolves(pinned);
    const handler = {
        config: { NETWORK: 'regtest', COIN: 'BTC', MAX_MEMO_LENGTH: 80 },
        util: { isNull: (v) => v === undefined || v === null || v === '', bclte: () => false },
        indexerDb: {
            isActionAllowed: sinon.stub().resolves(true),
            mirrorDb: () => ({ getPinnedRemoteToken }),
        },
    };
    return { handler, getPinnedRemoteToken };
}

function makeState(over = {}) {
    return {
        format: 0, error: false, isCrossChain: true, isNativeCoinGive: false,
        data: { SOURCE: 'src', GIVE_TICK: 'AAA', GET_COIN: 'LTC', GET_TICK: 'PEPECASH', BLOCK_INDEX: 100, BLOCK_TIME: 1 },
        ...over,
    };
}

function stubGate(active) {
    const activeAt = gateRegistry.activeAt;
    sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
        key === REMOTE_TOKEN_KEY ? active : activeAt(key, ...args));
}

// Simulate a registry with no remote token row.
function stubGateRowAbsent() {
    const activeAt = gateRegistry.activeAt;
    sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) => {
        if (key !== REMOTE_TOKEN_KEY) return activeAt(key, ...args);
        const miss = new Error('registry row absent');
        miss.name = 'RegistryMissError';
        throw miss;
    });
}

describe('Cross-chain remote token accept check @regression @tier2', function () {
    afterEach(() => sinon.restore());

    it('rejects a non-native cross-chain GET token with no pinned row once the gate is active', async function () {
        stubGate(true);
        const { handler, getPinnedRemoteToken } = makeHandler(null);
        const err = await remoteTokenAcceptError(handler, makeState());
        assert.strictEqual(err, 'invalid: GET_TICK (no pinned remote token)');
        assert.ok(getPinnedRemoteToken.calledOnceWithExactly('regtest', 'LTC', 'PEPECASH'));
    });

    it('accepts when a pinned row exists', async function () {
        stubGate(true);
        const { handler } = makeHandler({ decimals: 8, owner: 'x' });
        assert.strictEqual(await remoteTokenAcceptError(handler, makeState()), null);
    });

    it('does not look anything up while the gate is inactive', async function () {
        stubGate(false);
        const { handler, getPinnedRemoteToken } = makeHandler(null);
        assert.strictEqual(await remoteTokenAcceptError(handler, makeState()), null);
        assert.ok(getPinnedRemoteToken.notCalled);
    });

    it('preserves pre-gate behavior when the registry row is absent', async function () {
        stubGateRowAbsent();
        const { handler, getPinnedRemoteToken } = makeHandler(null);
        assert.strictEqual(await remoteTokenAcceptError(handler, makeState()), null);
        assert.ok(getPinnedRemoteToken.notCalled);
    });

    it('rejects when the mirror reader is not installed', async function () {
        stubGate(true);
        const { handler } = makeHandler(null);
        delete handler.indexerDb.mirrorDb;
        assert.strictEqual(await remoteTokenAcceptError(handler, makeState()), 'invalid: GET_TICK (no pinned remote token)');
    });

    it('rejects when the mirror database is unavailable', async function () {
        stubGate(true);
        const { handler } = makeHandler(null);
        handler.indexerDb.mirrorDb = () => null;
        assert.strictEqual(await remoteTokenAcceptError(handler, makeState()), 'invalid: GET_TICK (no pinned remote token)');
    });

    it('skips native GET, local GET and non-create formats', async function () {
        stubGate(true);
        const { handler, getPinnedRemoteToken } = makeHandler(null);
        const base = makeState();
        assert.strictEqual(await remoteTokenAcceptError(handler, makeState({ data: { ...base.data, GET_TICK: '' } })), null);
        assert.strictEqual(await remoteTokenAcceptError(handler, makeState({ isCrossChain: false })), null);
        assert.strictEqual(await remoteTokenAcceptError(handler, makeState({ format: 1 })), null);
        assert.ok(getPinnedRemoteToken.notCalled);
    });

    for (const [name, mod] of [['ORDER', orderValidate], ['SWAP', swapValidate]]) {
        it(`${name} validateGeneral marks the create invalid with no pinned row`, async function () {
            stubGate(true);
            const { handler } = makeHandler(null);
            const st = makeState();
            await mod.validateGeneral(handler, st);
            assert.strictEqual(st.error, 'invalid: GET_TICK (no pinned remote token)');
        });

        it(`${name} validateGeneral keeps an earlier verdict`, async function () {
            stubGate(true);
            const { handler, getPinnedRemoteToken } = makeHandler(null);
            const st = makeState({ error: 'invalid: earlier' });
            await mod.validateGeneral(handler, st);
            assert.strictEqual(st.error, 'invalid: earlier');
            assert.ok(getPinnedRemoteToken.notCalled);
        });

        it(`${name} validateGeneral passes with a pinned row`, async function () {
            stubGate(true);
            const { handler } = makeHandler({ decimals: 0 });
            const st = makeState();
            await mod.validateGeneral(handler, st);
            assert.ok(!st.error);
        });
    }
});
