// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';
process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';
const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../../fixtures/mocks');
const swq   = require('../../../../src/stake_weighted_quorum.js');
const fs    = require('fs');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');
const ADMIT_AT  = 799000;
const LEGACY_AT = ADMIT_AT - 1;
const NETWORK   = 'regtest';
const PRICE_DIR = __dirname + '/../../../../src/actions/price';
const ARMED_MODULES = ['../../../../src/mirror_admission_activation.js', '../../../../src/consensus/ed25519.js']
    .concat(fs.readdirSync(PRICE_DIR, { recursive: true }).filter(f => f.endsWith('.js')).sort()
        .map(f => '../../../../src/actions/price/' + f));
const HUB_MODULES = [
    '../../../../../xchain-hub/src/mirror_admission_activation.js',
    '../../../../../xchain-hub/src/lib/admission_height.js',
    '../../../../../xchain-hub/src/oracle/price_aggregator.js'
];
let armed = null;
function armTwins() {
    const paths = ARMED_MODULES.map(m => require.resolve(m));
    const hubRefusal = HUB_MODULES.map(m => siblingCheckout(__dirname, m))
        .find(v => !v.usable && fs.existsSync(v.path)) || null;
    let hubPaths = null;
    if (!hubRefusal) {
        try { hubPaths = HUB_MODULES.map(m => require.resolve(m)); }
        catch (e) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('PRICE admission wire carrier cannot run: xchain-hub sibling missing (' + e.message + ')');
        }
    }
    const all      = paths.concat(hubPaths || []);
    const saved    = all.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of all) delete require.cache[p];
    process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(ADMIT_AT);
    const act     = require('../../../../src/mirror_admission_activation.js');
    const ed      = require('../../../../src/consensus/ed25519.js');
    const Price   = require('../../../../src/actions/price/index.js');
    const hubAgg  = hubPaths ? require('../../../../../xchain-hub/src/oracle/price_aggregator.js') : null;
    function restore() {
        for (const [p, mod] of saved) {
            if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
        }
        if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }
    return { act, ed, Price, hubAgg, hubRefusal, restore };
}
function newIdentity() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubkey: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex'), privateKey };
}
function signWith(id, payload) {
    return crypto.sign(null, Buffer.from(payload, 'utf8'), id.privateKey).toString('hex');
}
function batchBody(batch, opts = {}) {
    const out = [String(batch.firstRound), String(batch.lastRound),
                 String(batch.btcBlockHeight), String(batch.rounds.length)];
    for (const r of batch.rounds) {
        out.push(String(r.round), String(r.timestamp), String(r.btcBlockHeight), String(r.pairs.length));
        for (const p of r.pairs) out.push(String(p.pair), String(p.price));
        if (r.admitBlocks && !opts.dropSlot)
            out.push(opts.slotOverride !== undefined ? opts.slotOverride : armed.act.encodeAdmitBlocks(r.admitBlocks));
        if (opts.extraPerRound) out.push(opts.extraPerRound);
    }
    out.push(String(batch.sigs.length));
    for (const s of batch.sigs) out.push(s.pubkey, s.sig);
    return out;
}
const wireParams = body => ['2'].concat(body);
function twoRounds(anchorBase, maps) {
    return [0, 1].map(i => {
        let r = {
            round:          100 + i,
            timestamp:      1700000000 + (i * 600),
            btcBlockHeight: anchorBase + i,
            pairs: [{ pair: 'BTC/USD', price: '50000.00' }, { pair: 'LTC/USD', price: '95.5' }]
        };
        if (maps && maps[i] !== undefined) r.admitBlocks = maps[i];
        return r;
    });
}
const MAPS = [{ BTC: 799004, DOGE: 5000004 }, { LTC: 2400004, BTC: 799005 }];
function wireHooks() {
    before(function () { armed = armTwins(); });
    after(function () { if (armed) armed.restore(); armed = null; });
}
let indexer, hubClient, capable;
function signBatch(rounds, ids) {
    const firstRound     = rounds[0].round;
    const lastRound      = rounds[rounds.length - 1].round;
    const btcBlockHeight = rounds[rounds.length - 1].btcBlockHeight;
    const payload = armed.ed.buildPriceBatchPayload(firstRound, lastRound, btcBlockHeight, rounds, NETWORK);
    return { firstRound, lastRound, btcBlockHeight, rounds, payload,
             sigs: ids.map(id => ({ pubkey: id.pubkey, sig: signWith(id, payload) })) };
}
function newHandler() {
    return new armed.Price({
        config: indexer.config, util: indexer.util, mapper: indexer.mapper,
        decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb, hubClient
    });
}
function batchHooks() {
    beforeEach(function () {
        indexer = createMockIndexer();
        capable = new Set();
        const db = indexer.indexerDb;
        db.createPrice                 = sinon.stub().resolves();
        db.hasCapability               = sinon.stub().callsFake(async k => capable.has(String(k).toLowerCase()));
        db.getValidatorsByCapability   = sinon.stub().callsFake(async () => {
            const rows = [...capable].map(pubkey => ({ pubkey, amount: '100' }));
            rows.truncated = false;
            return rows;
        });
        db.getActiveCapabilityCount    = sinon.stub().resolves(1);
        db.getStakeWeightsByCapability = sinon.stub().resolves([]);
        db.enqueueHubPushTx            = sinon.stub().resolves(42);
        db.stageHubPush                = sinon.stub();
        db.getPushGeneration           = sinon.stub().resolves(3);
        hubClient = { enabled: true, pushPriceBatch: sinon.stub().resolves() };
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    });
    afterEach(function () { sinon.restore(); });
}
function validBatch(anchorBase, maps) {
    const id = newIdentity();
    capable.add(id.pubkey);
    return signBatch(twoRounds(anchorBase === undefined ? ADMIT_AT : anchorBase, maps), [id]);
}
const batchData = (over = {}) => createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100, ...over });

describe('the admission map rides the on-chain price wire one slot per round (rows 17 and 26)', function () {
    wireHooks();
    describe('the on-chain batch action, driven through the real parser', function () {
        batchHooks();

        it('the canonical refuses in both directions: an era round with no map, a legacy round with one', function () {
            const era = twoRounds(ADMIT_AT);
            assert.throws(() => armed.ed.buildPriceBatchPayload(100, 101, ADMIT_AT + 1, era, NETWORK),
                          /admission-era row at block 799000 .* has no admit_blocks/);
            const legacy = twoRounds(LEGACY_AT - 10, MAPS);
            assert.throws(() => armed.ed.buildPriceBatchPayload(100, 101, LEGACY_AT - 9, legacy, NETWORK),
                          /legacy-era row .* was handed admit_blocks/);
            // And a caller that omits the network rebuilds LEGACY bytes: an era batch then fails
            // to verify rather than verifying as legacy, which is the fail-closed direction.
            assert.strictEqual(/admit/.test(armed.ed.buildPriceBatchPayload(100, 101, LEGACY_AT - 9, twoRounds(LEGACY_AT - 10))), false);
        });

        it('below the activation there is no slot: a trailing field still INVALIDATES the batch', async function () {
            const data = batchData();
            await newHandler().parse(wireParams(batchBody(validBatch(LEGACY_AT - 10), { extraPerRound: 'BTC:799004' })), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.strictEqual(/^invalid: /.test(data['STATUS']), true, data['STATUS']);
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.called, false);
        });

        it('a batch below the activation is on exactly the same road, so nothing regressed', async function () {
            const data = batchData();
            await newHandler().parse(wireParams(batchBody(validBatch(LEGACY_AT - 10))), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.calledOnce, true);
            const [, payload] = indexer.indexerDb.enqueueHubPushTx.firstCall.args;
            for (const r of payload.rounds)
                assert.deepStrictEqual(Object.keys(r).sort(), ['btc_block_height', 'pairs', 'round', 'timestamp']);
            assert.strictEqual(/admit/.test(String(data['ROUNDS_JSON'])), false);
        });
    });
});
