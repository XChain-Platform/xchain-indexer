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
// ANCHOR v0 replay watermark after a regtest chain reset. A reset regtest chain
// leaves unverified bundle rows from the abandoned history at seqs the fresh
// chain has not reached yet; regtest reads only verified rows for the stale-seq
// guard, the same scope the archive head uses. Mainnet and testnet keep the
// all-status read and its verdict.

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { createBaseData } = require('../../../fixtures/mocks');
const { armAnchor, disarmAnchor, v0Params } =
    require('./anchor.test/helpers/anchor_fixtures.js');
const protocolChanges = require('../../../../src/protocol_changes.js');

const anchorActivation = protocolChanges.copy('anchor_activation.ANCHOR_ACTIVATION');
const BIND_ENV = 'XC_ANCHOR_CHECKPOINT_SEQ_BIND_REGTEST_ACTIVATION';
const STALE = 'invalid: SECTION 0 CHECKPOINT_SEQ (stale; replay of an older checkpoint)';

// Abandoned-chain rows sit at seq 28177 but none of them verified; the fresh
// chain's verified history tops out at `verifiedMax` (null when there is none).
function abandonedChainWatermark(verifiedMax){
    return async (_chain, _network, validOnly) => validOnly ? verifiedMax : 28177;
}

// Shared arm and disarm for both describes. The regtest bind gate is unarmed so
// the regtest rule alone selects the verified-row read, not the gate.
const ctx = {};

function arm(){
    ctx.saved = process.env[BIND_ENV];
    delete process.env[BIND_ENV];
    ctx.armed = armAnchor();
}

function disarm(){
    disarmAnchor(ctx.armed);
    if(ctx.saved === undefined) delete process.env[BIND_ENV];
    else process.env[BIND_ENV] = ctx.saved;
}

async function parseBundle(network, seq, blockIndex){
    ctx.armed.indexer.config.NETWORK = network;
    const fields = { ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' };
    if(blockIndex !== undefined) fields.BLOCK_INDEX = blockIndex;
    const data = createBaseData(fields);
    await ctx.armed.handler.parse(v0Params({
        network,
        sections: [{ chain: 'BTC', seq, snapshot: '100' }],
    }), data, null);
    return data;
}

describe('ANCHOR v0 replay watermark after a regtest chain reset @regression @tier3', function () {
    beforeEach(arm);
    afterEach(disarm);

    it('accepts a fresh regtest bundle below unverified rows of an abandoned chain', async function () {
        const db = ctx.armed.indexer.indexerDb;
        db.getMaxAnchorCheckpointSeq.callsFake(abandonedChainWatermark(null));

        const data = await parseBundle('regtest', '6552');

        assert.strictEqual(data.STATUS, 'valid');
        assert.ok(db.getMaxAnchorCheckpointSeq.calledOnceWithExactly('BTC', 'regtest', true));
    });

    it('accepts a fresh regtest bundle that advances past the verified rows', async function () {
        const db = ctx.armed.indexer.indexerDb;
        db.getMaxAnchorCheckpointSeq.callsFake(abandonedChainWatermark(6480));

        const data = await parseBundle('regtest', '6552');

        assert.strictEqual(data.STATUS, 'valid');
    });

    it('still refuses a regtest replay below a verified row', async function () {
        const db = ctx.armed.indexer.indexerDb;
        db.getMaxAnchorCheckpointSeq.callsFake(abandonedChainWatermark(6600));

        const data = await parseBundle('regtest', '6552');

        assert.strictEqual(data.STATUS, STALE);
        assert.ok(db.getMaxAnchorCheckpointSeq.calledOnceWithExactly('BTC', 'regtest', true));
        assert.ok(db.createValidatorReward.notCalled);
    });
});

// The same abandoned-chain rows on mainnet and testnet keep the all-status read,
// so the unverified row at 28177 still refuses the bundle exactly as before the
// regtest rule.
describe('ANCHOR v0 replay watermark on mainnet and testnet is unchanged @regression @tier3', function () {
    beforeEach(arm);
    afterEach(disarm);

    for(const network of ['mainnet', 'testnet']){
        it('keeps the ' + network + ' stale refusal on the same rows', async function () {
            const db = ctx.armed.indexer.indexerDb;
            db.getMaxAnchorCheckpointSeq.callsFake(abandonedChainWatermark(null));

            const data = await parseBundle(network, '6552', anchorActivation[network] + 1);

            assert.strictEqual(data.STATUS, STALE);
            assert.strictEqual(db.getMaxAnchorCheckpointSeq.callCount, 1);
            assert.deepStrictEqual(db.getMaxAnchorCheckpointSeq.firstCall.args,
                ['BTC', network, false]);
            assert.ok(db.createValidatorReward.notCalled);
        });

        it('keeps the ' + network + ' acceptance at the all-status watermark', async function () {
            const db = ctx.armed.indexer.indexerDb;
            db.getMaxAnchorCheckpointSeq.callsFake(abandonedChainWatermark(null));

            const data = await parseBundle(network, '28177', anchorActivation[network] + 1);

            assert.strictEqual(data.STATUS, 'valid');
            assert.deepStrictEqual(db.getMaxAnchorCheckpointSeq.firstCall.args,
                ['BTC', network, false]);
        });
    }
});
