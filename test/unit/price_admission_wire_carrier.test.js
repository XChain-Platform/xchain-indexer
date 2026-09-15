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
// test/unit/price_admission_wire_carrier.test.js
//
// THE INDEXER HALF OF THE ADMISSION MAP'S WIRE CARRIER (frontier row 17).
//
// The indexer is the VERIFIER on this rail: it rebuilds, from the on-chain action alone,
// the exact bytes a quorum of validators signed. So two separate things have to hold, and
// only one of them holds today:
//
//   1. THE ROUND CANONICAL. When the indexer is handed a round's admission map it must
//      decode the wire field to exactly the map the producer encoded, re-encode it to the
//      identical bytes, and rebuild a canonical the hub's own verifier accepts. Driven here
//      as a ROUND TRIP in both eras, because a verifier that can read the bytes but not
//      reproduce them is a verifier that rejects every honest round.
//
//   2. THE ON-CHAIN CARRIER. There is none. The only format-0 wire the parser accepts is
//      the BATCH, and neither the batch wire nor buildPriceBatchPayload has any slot for an
//      admission map: the canonical serializes {round, timestamp, btc_block_height, pairs}
//      per round and nothing else. This file MEASURES that rather than asserting it in
//      prose, because it is the precondition the producer row depends on: until the batch
//      canonical carries the field across its three byte-twins, a map on this wire would be
//      an unsigned consensus field any relay could rewrite with every signature still
//      verifying. The hub refuses an admission-era batch for exactly this reason.
//
// THE SUITE ARMS ITSELF. The activation resolver freezes at require time, so setting the
// variable afterwards arms nothing and every admission case would report PENDING.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');
const swq   = require('../../src/stake_weighted_quorum.js');
const fs    = require('fs');
const { siblingCheckout, skipOrFail } = require('../helpers/sibling_checkout.js');

// The regtest producer activation this suite arms, keyed on the ROUND's own BTC anchor.
const ADMIT_AT  = 799000;
const LEGACY_AT = ADMIT_AT - 1;
const NETWORK   = 'regtest';

// Every module in this repo that closes over the activation: the parser reads the era to
// decide whether a round has a slot, so it is armed with the twin or it never reads one.
// The PRICE handler is an entry plus parts, and a part holds whatever it required when it
// first loaded: batch_signatures.js keeps the ed25519 module it was handed, so a part left
// in the cache by an earlier suite calls the UNARMED canonical builder, which refuses a
// round map as legacy-era. That failure only shows in the full tier, never alone, so every
// file under src/actions/price/ is re-required, not just the parts named when this list
// was written.
const PRICE_DIR = __dirname + '/../../src/actions/price';
const ARMED_MODULES = ['../../src/mirror_admission_activation.js', '../../src/consensus/ed25519.js']
    .concat(fs.readdirSync(PRICE_DIR, { recursive: true }).filter(f => f.endsWith('.js')).sort()
        .map(f => '../../src/actions/price/' + f));
// The hub's verifier twin, so the round trip is driven across the repo boundary the wire
// actually crosses rather than inside one repo's own idea of the bytes.
const HUB_MODULES = [
    '../../../xchain-hub/src/mirror_admission_activation.js',
    '../../../xchain-hub/src/lib/admission_height.js',
    '../../../xchain-hub/src/oracle/price_aggregator.js'
];

let armed = null;

function armTwins() {
    const paths = ARMED_MODULES.map(m => require.resolve(m));
    // A hub twin that is PRESENT but reached through a lane symlink into a live main checkout
    // is refused, not read; the hub-reading cases skip or fail on it by name. Absence is left
    // alone: this suite has always failed when the hub twin is missing, and still does.
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

    const act     = require('../../src/mirror_admission_activation.js');
    const ed      = require('../../src/consensus/ed25519.js');
    const Price   = require('../../src/actions/price/index.js');
    const hubAgg  = hubPaths ? require('../../../xchain-hub/src/oracle/price_aggregator.js') : null;

    function restore() {
        for (const [p, mod] of saved) {
            if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
        }
        if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }
    return { act, ed, Price, hubAgg, hubRefusal, restore };
}

// ---------------------------------------------------------------------------
// The on-chain batch wire, assembled exactly as price_batch.test.js assembles it:
// `body` is the field list AFTER "PRICE|0|".
// ---------------------------------------------------------------------------
function newIdentity() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubkey: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex'), privateKey };
}
function signWith(id, payload) {
    return crypto.sign(null, Buffer.from(payload, 'utf8'), id.privateKey).toString('hex');
}

// A round's ADMIT_BLOCKS slot rides after its pairs, spelled through the encoder, exactly
// when the round carries a map; `slotOverride` replaces that spelling (a malformed slot) and
// `extraPerRound` appends an UNDECLARED field after every round, which is how a map would
// have had to ride this wire before the slot existed.
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

// Two rounds at [anchorBase, anchorBase + 1]; maps[i], when given, is round i's map.
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
        // The count-quorum path; regtest arms stake weighting at genesis.
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

    it('is ARMED for this suite, so neither era case is vacuous', function () {
        assert.strictEqual(armed.act.isMirrorAdmissionProducerActive('BTC', NETWORK, ADMIT_AT), true);
        assert.strictEqual(armed.act.isMirrorAdmissionProducerActive('BTC', NETWORK, LEGACY_AT), false);
        if (armed.hubRefusal) return skipOrFail(this, armed.hubRefusal, 'the PRICE admission wire carrier hub twin');
        assert.notStrictEqual(armed.hubAgg, null,
            'the hub verifier twin must be resolvable in a monorepo run');
    });
});

describe('the admission map rides the on-chain price wire one slot per round (rows 17 and 26)', function () {
    wireHooks();
    // -----------------------------------------------------------------------
    // 1. the ROUND canonical round-trips across the repo boundary
    // -----------------------------------------------------------------------
    describe('the round canonical: encode, carry, decode, re-encode', function () {

        const MAP   = { DOGE: 5000004, BTC: 799004, LTC: 2400004 };   // deliberately unsorted
        const FIELD = 'BTC:799004,DOGE:5000004,LTC:2400004';
        const PAIRS = [{ pair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '80' }];

        function hubCanonical(height, map) {
            const PriceAggregator = armed.hubAgg;
            const agg = new PriceAggregator({ db: null, network: NETWORK, getPeerManager: () => ({}) });
            return agg._buildPriceV0Payload(5, 1700000000, PAIRS, height, map);
        }

        it('decodes the producer\'s field to the producer\'s map, byte for byte both ways', function () {
            if (armed.hubRefusal) return skipOrFail(this, armed.hubRefusal, 'the hub round canonical round trip');
            const canonical = hubCanonical(ADMIT_AT, MAP);
            const field     = canonical.slice(canonical.lastIndexOf('|') + 1);
            assert.strictEqual(field, FIELD, 'the hub did not append the canonical field');

            // The verifier's actual job: read a field it did not write.
            const decoded = armed.act.decodeAdmitBlocks(field);
            assert.deepStrictEqual(decoded, { BTC: 799004, DOGE: 5000004, LTC: 2400004 });
            assert.strictEqual(armed.act.encodeAdmitBlocks(decoded), field,
                're-encoding the decoded map did not reproduce the signed bytes');

            // And the whole canonical rebuilt from the DECODED map is the hub's byte for
            // byte, which is the only thing a signature check actually cares about.
            assert.strictEqual(
                armed.ed.buildPriceV0Payload(5, 1700000000, PAIRS, NETWORK, ADMIT_AT, decoded),
                canonical);
        });

        it('below the activation the bytes are the pre-change bytes exactly', function () {
            if (armed.hubRefusal) return skipOrFail(this, armed.hubRefusal, 'the hub legacy round canonical');
            const canonical = hubCanonical(LEGACY_AT, undefined);
            assert.strictEqual(canonical.endsWith('}'), true, canonical.slice(-40));
            assert.strictEqual(/BTC:/.test(canonical), false);
            assert.strictEqual(
                armed.ed.buildPriceV0Payload(5, 1700000000, PAIRS, NETWORK, LEGACY_AT, undefined),
                canonical);
        });

        it('refuses every non-canonical spelling of the same map, so the field is injective', function () {
            for (const bad of ['BTC:0799004', 'DOGE:5000004,BTC:799004', 'BTC:799004,BTC:799004',
                               'btc:799004', '', 'BTC:799004,'])
                assert.strictEqual(armed.act.decodeAdmitBlocks(bad), null, JSON.stringify(bad));
        });
    });
});

describe('the admission map rides the on-chain price wire one slot per round (rows 17 and 26)', function () {
    wireHooks();
    // -----------------------------------------------------------------------
    // 2. the on-chain BATCH wire: measured, not assumed
    // -----------------------------------------------------------------------
    describe('the on-chain batch action, driven through the real parser', function () {
        batchHooks();








        it('THE CARRIER: an admission-era batch carries one map per round, parsed, stored and pushed as signed', async function () {
            const data = batchData();
            await newHandler().parse(wireParams(batchBody(validBatch(ADMIT_AT, MAPS))), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            const stored = JSON.parse(data['ROUNDS_JSON']);
            assert.deepStrictEqual(stored.map(r => r.admit_blocks), MAPS,
                'the stored round bodies do not carry the maps the wire carried');

            const [pushType, payload] = indexer.indexerDb.enqueueHubPushTx.firstCall.args;
            assert.strictEqual(pushType, 'price_batch');
            // The top-level key SET is unchanged (the hub destructures exactly these names);
            // the map rides INSIDE each round, which the hub passes through whole.
            assert.deepStrictEqual(Object.keys(payload).sort(), [
                'action_index', 'block_index', 'block_time', 'btc_block_height',
                'first_round', 'last_round', 'push_generation', 'rounds', 'sigs', 'source_chain'
            ]);
            for (const r of payload.rounds)
                assert.deepStrictEqual(Object.keys(r).sort(),
                    ['admit_blocks', 'btc_block_height', 'pairs', 'round', 'timestamp']);
            assert.deepStrictEqual(payload.rounds.map(r => r.admit_blocks), MAPS);
        });

        it('the hub verifier rebuilds the SAME bytes from the pushed rounds, across the repo boundary', function () {
            const b   = validBatch(ADMIT_AT, MAPS);
            if (armed.hubRefusal) return skipOrFail(this, armed.hubRefusal, 'the hub verifier batch rebuild');
            const agg = new armed.hubAgg({ db: null, network: NETWORK, getPeerManager: () => ({}) });
            // The hub's ingest shape: snake-cased rounds with admit_blocks, as the push carries them.
            const pushed = b.rounds.map(r => ({ round: r.round, timestamp: r.timestamp,
                btcBlockHeight: r.btcBlockHeight, pairs: r.pairs, admitBlocks: r.admitBlocks }));
            assert.strictEqual(agg._buildPriceBatchPayload(b.firstRound, b.lastRound, b.btcBlockHeight, pushed), b.payload);
            // And the map is the LAST key of each round, spelled through the one encoder.
            const body = JSON.parse(b.payload.slice(b.payload.indexOf('{')));
            assert.deepStrictEqual(Object.keys(body.rounds[0]), ['round', 'timestamp', 'btc_block_height', 'pairs', 'admit_blocks']);
            assert.strictEqual(body.rounds[0].admit_blocks, 'BTC:799004,DOGE:5000004');
            assert.strictEqual(body.rounds[1].admit_blocks, 'BTC:799005,LTC:2400004');
        });
    });
});
describe('the admission map rides the on-chain price wire one slot per round (rows 17 and 26)', function () {
    wireHooks();
    describe('the on-chain batch action, driven through the real parser', function () {
        batchHooks();

        it('an admission-era batch with NO slot is invalid: the missing field shifts SIG_COUNT and nothing pushes', async function () {
            const data = batchData();
            await newHandler().parse(wireParams(batchBody(validBatch(ADMIT_AT, MAPS), { dropSlot: true })), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.strictEqual(/^invalid: /.test(data['STATUS']), true, data['STATUS']);
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.called, false);
        });

        it('a non-canonical spelling in the slot is refused by name, before any signature is read', async function () {
            const data = batchData();
            await newHandler().parse(wireParams(batchBody(validBatch(ADMIT_AT, MAPS), { slotOverride: 'DOGE:5000004,BTC:799004' })), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.strictEqual(data['STATUS'], 'invalid: invalid ADMIT_BLOCKS at index 0');
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.called, false);
        });

        it('a map edited on the wire fails every signature, so the slot cannot be used to rewrite one', async function () {
            const data = batchData();
            const b = validBatch(ADMIT_AT, MAPS);
            b.rounds[1].admitBlocks = { LTC: 2400004, BTC: 799006 };   // signed 799005
            await newHandler().parse(wireParams(batchBody(b)), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.called, false);
        });

        it('a window straddling the activation is invalid, so no batch carries a mixed set', async function () {
            const data = batchData();
            // round 100 at LEGACY_AT (no slot), round 101 at ADMIT_AT (slot): a mixed set.
            await newHandler().parse(wireParams(batchBody(validBatch(LEGACY_AT, [undefined, MAPS[1]]))), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.strictEqual(data['STATUS'], 'invalid: batch straddles an oracle flag day');
        });
    });
});
