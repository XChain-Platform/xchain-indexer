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
// test/unit/price/price_admission_shipped_testnet_boundary.test.js
//
// THE ADMIT_BLOCKS SLOT IS NEVER READ BELOW ITS OWN ACTIVATION HEIGHT, driven on the
// SHIPPED testnet map rather than on an env-armed regtest stand-in.
//
// Every other admission suite in this repo arms XC_MIRROR_ADMISSION_ACTIVATION and drives
// regtest, so all of them would stay green if the shipped testnet height were sized wrong,
// sized to zero, or consulted after the decode instead of before it. That is the one defect
// class this family exists to prevent: a rule applied below its activation re-judges history
// that was valid when it was written, and on a live chain it forks the ledger.
//
// So this file reads MIRROR_ADMISSION_ACTIVATION['BTC:testnet'] and drives the real PRICE v0
// batch parser at H-1, at H and across the boundary, with no stubbed gate anywhere.
//
// THE TWO AXES ARE DELIBERATELY CROSSED. BLOCK_TIME is held below every testnet TIME gate
// (price range, price scale, pair names) while the ROUND ANCHOR walks the admission HEIGHT
// gate, because the admission era is keyed on the round's own BTC anchor and on nothing
// else. A batch that is legacy on the time axis and era on the height axis is exactly the
// shape that made the price-range suite read as a below-gate regression, and it is the shape
// that proves the two axes are independent.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Price   = require('../../../src/actions/price/index.js');
const ed25519 = require('../../../src/consensus/ed25519.js');
const swq     = require('../../../src/consensus/stake_weighted_quorum.js');
const adm     = require('../../../src/consensus/gates/mirror_admission_gate.js');

const NETWORK = 'testnet';

// The shipped producer height for this rail, read from the registry row and never typed
// here: a suite carrying its own copy of the number would stay green against a height that
// had been re-sized underneath it.
const ADMIT_AT  = adm.MIRROR_ADMISSION_ACTIVATION['BTC:' + NETWORK];
const LEGACY_AT = ADMIT_AT - 2;

// Below every testnet time-keyed price gate, so the time axis grades nothing here.
const BLOCK_TIME = 1700000000;
const HONEST     = '50000.00000000';

// One round's admission map. The heights are arbitrary and only have to be canonically
// spellable; the boundary under test is the round's ANCHOR, never these.
const MAPS = [{ BTC: 900001, DOGE: 5000004 }, { BTC: 900002, LTC: 2400004 }];

function newIdentity(){
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubkey: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex'), privateKey };
}
function signWith(id, payload){
    return crypto.sign(null, Buffer.from(payload, 'utf8'), id.privateKey).toString('hex');
}

// Two rounds anchored from `anchorBase`, carrying `maps` when the caller wants an era batch.
function twoRounds(anchorBase, maps){
    return [0, 1].map(i => {
        let r = {
            round:          100 + i,
            timestamp:      1700000000 + (i * 600),
            btcBlockHeight: anchorBase + i,
            pairs: [{ pair: 'BTC/USD', price: HONEST }],
        };
        if(maps && maps[i] !== undefined) r.admitBlocks = maps[i];
        return r;
    });
}

// The uncompressed wire, with the ADMIT_BLOCKS slot appended per round exactly where the
// parser reads it: after that round's pair list, before the next round block.
function batchBody(batch){
    const out = [String(batch.firstRound), String(batch.lastRound),
                 String(batch.btcBlockHeight), String(batch.rounds.length)];
    for(const r of batch.rounds){
        out.push(String(r.round), String(r.timestamp), String(r.btcBlockHeight), String(r.pairs.length));
        for(const p of r.pairs) out.push(String(p.pair), String(p.price));
        if(r.admitBlocks) out.push(adm.encodeAdmitBlocks(r.admitBlocks));
    }
    out.push(String(batch.sigs.length));
    for(const s of batch.sigs) out.push(s.pubkey, s.sig);
    return out;
}
const wireParams = body => ['2'].concat(body);

let indexer, hubClient, capable;

// The network reaches the canonical builder, so an era batch is signed over era bytes and a
// legacy batch over legacy bytes: the same rule the parser resolves on the same anchor.
function signBatch(rounds, ids, network){
    const firstRound     = rounds[0].round;
    const lastRound      = rounds[rounds.length - 1].round;
    const btcBlockHeight = rounds[rounds.length - 1].btcBlockHeight;
    const payload = ed25519.buildPriceBatchPayload(firstRound, lastRound, btcBlockHeight, rounds, network);
    return { firstRound, lastRound, btcBlockHeight, rounds,
             sigs: ids.map(id => ({ pubkey: id.pubkey, sig: signWith(id, payload) })) };
}
function validBatch(anchorBase, maps, network){
    const id = newIdentity();
    capable.add(id.pubkey);
    return signBatch(twoRounds(anchorBase, maps), [id], network);
}
function newHandler(network){
    return new Price({
        config:    Object.assign({}, indexer.config, { NETWORK: network }),
        util:      indexer.util,
        mapper:    indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        hubClient: hubClient,
    });
}
const batchData = (over = {}) => createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100,
    BLOCK_TIME: BLOCK_TIME, ...over });

// The mock indexer, the price-capable set and the count-quorum path every sibling v0 suite
// drives. Kept out of the describe so no test body is buried under harness wiring.
function installHarness(){
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
    db.getPushGeneration           = sinon.stub().resolves(1);
    hubClient = { enabled: true, pushPriceBatch: sinon.stub().resolves() };
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
}

// Fails loudly rather than skipping. An unsized height makes every case below vacuous, and a
// suite that quietly passes on a gate nobody armed is the exact reading this family already
// lost once.
function railIsSized(){
    assert.ok(Number.isFinite(ADMIT_AT) && ADMIT_AT > 1,
        'MIRROR_ADMISSION_ACTIVATION[BTC:' + NETWORK + '] is ' + JSON.stringify(ADMIT_AT) +
        ', so this boundary suite has nothing to drive');
    assert.strictEqual(adm.isAdmissionEra(NETWORK, ADMIT_AT - 1), false);
    assert.strictEqual(adm.isAdmissionEra(NETWORK, ADMIT_AT), true);
}

async function belowTheHeightTheSlotIsNeverRead(){
    const data = batchData();
    await newHandler(NETWORK).parse(wireParams(batchBody(validBatch(LEGACY_AT, null, NETWORK))), data, null);

    // The regression this file is named for: a below-gate batch must never be judged by a
    // rule that arms above it. 'invalid ADMIT_BLOCKS' here is the ledger fork.
    assert.strictEqual(data['STATUS'], 'valid', data['STATUS']);
    assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
    assert.strictEqual(/admit/i.test(String(data['STATUS'])), false, data['STATUS']);
    assert.strictEqual(/admit/i.test(String(data['ROUNDS_JSON'])), false, 'a legacy round stores no map');
    assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.calledOnce, true);
}

async function atTheHeightTheSlotIsRequired(){
    // Signed with the network OMITTED, because the canonical builder itself refuses to spell
    // legacy bytes for an era round: a batch shaped like this can only come from a producer
    // that resolved the era wrong. The parser refuses it on the WIRE, before any signature is
    // reached, which is the fail-closed direction.
    const data = batchData();
    await newHandler(NETWORK).parse(wireParams(batchBody(validBatch(ADMIT_AT, null, undefined))), data, null);

    assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
    assert.ok(String(data['STATUS']).includes('invalid ADMIT_BLOCKS at index 0'), data['STATUS']);
    assert.strictEqual(data['ROUNDS_JSON'], null, 'nothing partial may be stored');
    assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.called, false);
}

async function atTheHeightACanonicalMapRoundTrips(){
    const data = batchData();
    await newHandler(NETWORK).parse(wireParams(batchBody(validBatch(ADMIT_AT, MAPS, NETWORK))), data, null);

    assert.strictEqual(data['STATUS'], 'valid', data['STATUS']);
    const stored = JSON.parse(String(data['ROUNDS_JSON']));
    assert.deepStrictEqual(stored.map(r => r.admit_blocks), MAPS,
        'the parsed map must reach storage as the producer signed it');
    assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.calledOnce, true);
}

// The mainnet row is null under the write hold, so no anchor puts a mainnet batch in the
// admission era. This is the same below-gate claim on the other key.
async function mainnetIsInertAtTheSameAnchors(){
    const data = batchData();
    await newHandler('mainnet').parse(wireParams(batchBody(validBatch(ADMIT_AT, null, 'mainnet'))), data, null);

    assert.strictEqual(data['STATUS'], 'valid', data['STATUS']);
    assert.strictEqual(/admit/i.test(String(data['ROUNDS_JSON'])), false);
}

// First round below, second round at: one signed action cannot carry two eras, so the
// straddle rule refuses it rather than judging the earlier round under the later rule.
async function aStraddlingWindowIsInvalid(){
    // Each round is spelled for ITS OWN era: the first carries no slot, the second carries
    // its map, and both are signed that way. So the batch reaches the straddle rule instead
    // of dying at the wire, and it is the straddle rule that refuses it.
    const data = batchData();
    await newHandler(NETWORK).parse(
        wireParams(batchBody(validBatch(ADMIT_AT - 1, [undefined, MAPS[1]], NETWORK))), data, null);

    assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
    assert.ok(String(data['STATUS']).includes('straddles an oracle flag day'), data['STATUS']);
}

describe('PRICE ADMIT_BLOCKS against the SHIPPED testnet admission height @regression @tier3', function () {
    beforeEach(installHarness);
    afterEach(function () { sinon.restore(); });

    it('the rail is SIZED, so neither side of the boundary below is the other one in disguise', railIsSized);
    it('BELOW the height the slot is never read, so the legacy verdict does not move', belowTheHeightTheSlotIsNeverRead);
    it('AT the height the slot is REQUIRED: the same legacy bytes become invalid', atTheHeightTheSlotIsRequired);
    it('AT the height a canonical map is accepted and round-trips into the stored body', atTheHeightACanonicalMapRoundTrips);
    it('MAINNET is inert at the same anchors, so the height gate is per-network', mainnetIsInertAtTheSameAnchors);
    it('a window that STRADDLES the height is invalid, which is what proves the era is per-anchor', aStraddlingWindowIsInvalid);
});
