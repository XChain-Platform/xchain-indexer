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
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');

const ar = require('../../../../src/consensus/gates/anchor_reward_gate.js');
const swq = require('../../../../src/consensus/stake_weighted_quorum.js');
const realMintRow = require('../../../../src/consensus/anchor_reward_derive/mint_row.js');

const DERIVE_PATH = require.resolve('../../../../src/consensus/anchor_reward_derive.js');
const MINT_PATH = require.resolve('../../../../src/consensus/anchor_reward_derive/mint_row.js');
const COUNTER_PATH = require.resolve('../../../../src/consensus/anchor_reward_derive/late_derive_counter.js');
const OBSERVABILITY_PATH = require.resolve('../../../../src/observability/index.js');

function makeKey(){
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { pubkey: spki.subarray(spki.length - 32).toString('hex'), privateKey };
}

function makeRow(deriveMod, key, roundReference, snapshotBlock){
    const row = {
        chain: 'BTC', network: 'regtest', reward_type: 'anchor_bundle',
        round_reference: roundReference, snapshot_block: snapshotBlock,
        publisher: key.pubkey, reward_amount: '10.00000000', doge_anchor_txid: 'a'.repeat(64),
    };
    const signature = crypto.sign(
        null, Buffer.from(deriveMod.rewardCanonical(row), 'utf8'), key.privateKey).toString('hex');
    row.publisher_attestations = JSON.stringify([{ pubkey: key.pubkey, sig: signature }]);
    return row;
}

function stubDb(key, rows){
    return {
        getValidatorsByCapability: sinon.stub().resolves([{ pubkey: key.pubkey, amount: '1' }]),
        getStakeWeightsByCapability: sinon.stub().resolves([{ pubkey: key.pubkey, source: key.pubkey, weight: '1' }]),
        getPendingAnchorRewardAttestations: sinon.stub().resolves(rows),
        createValidatorReward: sinon.stub().resolves(true),
        reconcileAnchorRewardWinner: sinon.stub().resolves(0),
    };
}

function cacheModule(modulePath, exports){
    require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
}

describe('deriveAnchorRewards late-derive observation wiring @regression @tier1', function () {
    const cfg = { COIN: 'BTC', NETWORK: 'regtest' };
    const saved = new Map();
    const logger = { warn: sinon.stub() };
    const mintStub = sinon.stub();
    const recordStub = sinon.stub();
    let deriveMod;

    before(function () {
        for(const path of [DERIVE_PATH, MINT_PATH, COUNTER_PATH, OBSERVABILITY_PATH]){
            saved.set(path, require.cache[path]);
        }
        delete require.cache[DERIVE_PATH];
        cacheModule(MINT_PATH, {
            AnchorProofUnavailableError: realMintRow.AnchorProofUnavailableError,
            mintProvenRow: mintStub,
        });
        cacheModule(COUNTER_PATH, { recordLateDerive: recordStub });
        cacheModule(OBSERVABILITY_PATH, { getLogger: () => logger });
        deriveMod = require(DERIVE_PATH);
    });

    after(function () {
        for(const [path, cached] of saved){
            if(cached) require.cache[path] = cached;
            else delete require.cache[path];
        }
    });

    beforeEach(function () {
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        mintStub.reset();
        mintStub.resolves(true);
        recordStub.reset();
        logger.warn.resetHistory();
    });

    afterEach(function () { sinon.restore(); });

    it('records each minted row with the loop block and mirror maturity', async function () {
        const key = makeKey();
        const rows = [makeRow(deriveMod, key, 100, 100), makeRow(deriveMod, key, 200, 200)];
        const blockIndex = 200 + ar.ANCHOR_REWARD_MIRROR_MATURITY;
        const derived = await deriveMod.deriveAnchorRewards(stubDb(key, rows), cfg, blockIndex, {});
        assert.strictEqual(derived, 2);
        assert.strictEqual(recordStub.callCount, 2);
        assert.deepStrictEqual(recordStub.firstCall.args, [logger, rows[0], blockIndex, ar.ANCHOR_REWARD_MIRROR_MATURITY]);
        assert.deepStrictEqual(recordStub.secondCall.args, [logger, rows[1], blockIndex, ar.ANCHOR_REWARD_MIRROR_MATURITY]);
    });

    it('still returns and reconciles when late-derive observation throws', async function () {
        const key = makeKey();
        const row = makeRow(deriveMod, key, 100, 100);
        const db = stubDb(key, [row]);
        const blockIndex = 100 + ar.ANCHOR_REWARD_MIRROR_MATURITY;
        recordStub.throws(new Error('counter unavailable'));
        const derived = await deriveMod.deriveAnchorRewards(db, cfg, blockIndex, {});
        assert.strictEqual(derived, 1);
        assert.ok(db.reconcileAnchorRewardWinner.calledOnce);
        assert.ok(logger.warn.calledOnce);
        assert.match(logger.warn.firstCall.args[0], /counter unavailable/);
    });
});
