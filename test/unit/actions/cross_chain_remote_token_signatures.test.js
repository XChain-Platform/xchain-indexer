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
// Signature re-verification of a pinned remote token before an ORDER or SWAP accepts it.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const gateRegistry = require('../../../src/consensus/gate_registry');
const { remoteTokenAcceptError, remoteTokenCanonical, REMOTE_TOKEN_KEY } = require('../../../src/actions/cross_chain_remote_token');
const { signedRemoteTokenRow, stubRemoteTokenValidators } = require('../../fixtures/mocks');

const REJECT = 'invalid: GET_TICK (no pinned remote token)';

function makeHandler(pinned) {
    return {
        config: { NETWORK: 'regtest', COIN: 'BTC' },
        util: { isNull: (v) => v === undefined || v === null || v === '' },
        indexerDb: stubRemoteTokenValidators({
            mirrorDb: () => ({ getPinnedRemoteToken: sinon.stub().resolves(pinned) }),
        }),
    };
}

const state = () => ({
    format: 0, error: false, isCrossChain: true,
    data: { GET_COIN: 'LTC', GET_TICK: 'PEPECASH', BLOCK_INDEX: 100, BLOCK_TIME: 1 },
});

describe('Pinned remote token signature re-verify @regression @tier2', function () {
    beforeEach(() => {
        const activeAt = gateRegistry.activeAt;
        sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
            key === REMOTE_TOKEN_KEY ? true : activeAt(key, ...args));
    });
    afterEach(() => sinon.restore());

    it('builds the hub XREMOTE canonical below the admission era', function () {
        const id = 'f90fc14ebe1f32e4140547e40be3f12e739fca4f8bcdfaf6534cdf33566d9682';
        // Regtest is below it too unless the venue sets XC_REMOTE_TOKEN_ADMISSION_REGTEST_ACTIVATION.
        for (const network of ['mainnet', 'testnet', 'regtest']) {
            assert.strictEqual(remoteTokenCanonical({
                snapshot_id: id, network, coin: 'btc', tick: 'XTOKEN', decimals: 8,
                owner: 'bcrt1qowner', source_action_index: 42, snapshot_block: 1200, finalizing_view: 2,
                admit_block_btc: 7, admit_block_ltc: 8, admit_block_doge: 9,
            }), `XREMOTE|${id}|2|${network}|BTC|XTOKEN|8|bcrt1qowner|42|1200`);
        }
    });
});

describe('Pinned remote token admission map in the signed bytes @regression @tier2', function () {
    const ARM = 'XC_REMOTE_TOKEN_ADMISSION_REGTEST_ACTIVATION';
    beforeEach(() => {
        process.env[ARM] = 'armed';
        const activeAt = gateRegistry.activeAt;
        sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
            key === REMOTE_TOKEN_KEY ? true : activeAt(key, ...args));
    });
    afterEach(() => { delete process.env[ARM]; sinon.restore(); });

    it('appends the admission map in the admission era and refuses a row without one', function () {
        const id = 'f90fc14ebe1f32e4140547e40be3f12e739fca4f8bcdfaf6534cdf33566d9682';
        const row = {
            snapshot_id: id, network: 'regtest', coin: 'btc', tick: 'XTOKEN', decimals: 8,
            owner: 'bcrt1qowner', source_action_index: 42, snapshot_block: 1200, finalizing_view: 2,
            admit_block_btc: 1204, admit_block_ltc: 5000, admit_block_doge: null,
        };
        assert.strictEqual(remoteTokenCanonical(row),
            `XREMOTE|${id}|2|regtest|BTC|XTOKEN|8|bcrt1qowner|42|1200|BTC:1204,LTC:5000`);
        assert.throws(() => remoteTokenCanonical({ ...row, admit_block_btc: null, admit_block_ltc: null }), /carries no admission map/);
    });

    it('accepts a pinned row signed over its map and rejects one whose map was altered', async function () {
        const map = { admit_block_btc: 1, admit_block_ltc: 1, admit_block_doge: 1 };
        assert.strictEqual(await remoteTokenAcceptError(makeHandler(signedRemoteTokenRow(map)), state()), null);
        const row = signedRemoteTokenRow(map);
        row.admit_block_ltc = 2;
        assert.strictEqual(await remoteTokenAcceptError(makeHandler(row), state()), REJECT);
    });
});

describe('Pinned remote token signature re-verify @regression @tier2', function () {
    beforeEach(() => {
        const activeAt = gateRegistry.activeAt;
        sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
            key === REMOTE_TOKEN_KEY ? true : activeAt(key, ...args));
    });
    afterEach(() => sinon.restore());

    it('accepts a row with a quorum of valid signatures', async function () {
        assert.strictEqual(await remoteTokenAcceptError(makeHandler(signedRemoteTokenRow()), state()), null);
    });

    it('rejects a row whose content was altered after signing', async function () {
        const row = signedRemoteTokenRow();
        row.decimals = 9;
        assert.strictEqual(await remoteTokenAcceptError(makeHandler(row), state()), REJECT);
    });

    it('rejects a row with no signatures or malformed JSON', async function () {
        assert.strictEqual(await remoteTokenAcceptError(makeHandler(signedRemoteTokenRow({ validator_signatures: '[]' })), state()), REJECT);
        assert.strictEqual(await remoteTokenAcceptError(makeHandler(signedRemoteTokenRow({ validator_signatures: 'nope' })), state()), REJECT);
    });

    it('rejects a sub-quorum row', async function () {
        const row = signedRemoteTokenRow();
        row.validator_signatures = JSON.stringify(JSON.parse(row.validator_signatures).slice(0, 1));
        assert.strictEqual(await remoteTokenAcceptError(makeHandler(row), state()), REJECT);
    });

    it('rejects a row signed by keys outside the validator set', async function () {
        const handler = makeHandler(signedRemoteTokenRow());
        handler.indexerDb.getValidatorsByCapability = sinon.stub().resolves([{ pubkey: 'ab'.repeat(32), source: 's', weight: '1' }]);
        handler.indexerDb.getStakeWeightsByCapability = handler.indexerDb.getValidatorsByCapability;
        assert.strictEqual(await remoteTokenAcceptError(handler, state()), REJECT);
    });

    it('rejects when the validator snapshot is not mirrored', async function () {
        const handler = makeHandler(signedRemoteTokenRow());
        handler.indexerDb.getValidatorsByCapability = sinon.stub().resolves([]);
        handler.indexerDb.getStakeWeightsByCapability = sinon.stub().resolves([]);
        assert.strictEqual(await remoteTokenAcceptError(handler, state()), REJECT);
    });
});

// Fail the validator-set read with the given error on both quorum paths.
function handlerWithFailingValidatorRead(error) {
    const handler = makeHandler(signedRemoteTokenRow());
    handler.indexerDb.getValidatorsByCapability = sinon.stub().rejects(error);
    handler.indexerDb.getStakeWeightsByCapability = sinon.stub().rejects(error);
    return handler;
}

describe('Pinned remote token signature re-verify @regression @tier2', function () {
    beforeEach(() => {
        const activeAt = gateRegistry.activeAt;
        sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
            key === REMOTE_TOKEN_KEY ? true : activeAt(key, ...args));
    });
    afterEach(() => sinon.restore());

    for (const errno of [1205, 1213]) {
        it(`halts on a DB errno ${errno} during the quorum read instead of committing a reject`, async function () {
            const fault = Object.assign(new Error('db fault'), { errno });
            await assert.rejects(remoteTokenAcceptError(handlerWithFailingValidatorRead(fault), state()), (e) => e === fault);
        });
    }

    it('halts on a price-barrier deferral during the quorum read', async function () {
        const fault = Object.assign(new Error('deferred'), { code: 'PRICE_BARRIER_DEFERRED' });
        await assert.rejects(remoteTokenAcceptError(handlerWithFailingValidatorRead(fault), state()), (e) => e === fault);
    });

    it('still rejects on a deterministic quorum-read error with no errno or code', async function () {
        assert.strictEqual(await remoteTokenAcceptError(handlerWithFailingValidatorRead(new Error('boom')), state()), REJECT);
    });
});
