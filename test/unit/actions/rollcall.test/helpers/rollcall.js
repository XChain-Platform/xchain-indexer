// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const crypto = require('crypto');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../../../fixtures/mocks');

const Rollcall = require('../../../../../src/actions/rollcall/index.js');
const eq       = require('../../../../../src/equivocation_header.js');
const rca      = require('../../../../../src/rollcall_activation.js');
const rga      = require('../../../../../src/rollcall_gates_activation.js');
const { buildRollcallCanonical } = require('../../../../../src/actions/rollcall/rollcall_canonical.js');
const { knownGateKeys }          = require('../../../../../src/consensus_rules_digest.js');

const NETWORK = 'regtest';
const EPOCH   = 30;                       // ROLLCALL_INTERVAL_BLOCKS.regtest
const LEDGER  = 'ab'.repeat(32);
// The publisher's list as a v1 roll call carries it: comma-joined, sorted.
const GATES   = knownGateKeys().join(',');

function identity(){
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        pubkey: publicKey.export({ format: 'der', type: 'spki' }).slice(12).toString('hex'),
        priv:   privateKey
    };
}

// The canonical the hub signs and the BTC close re-verifies. Built from the
// CARRIED fields, so a roll call cannot be pre-signed before its epoch block exists.
function signFor(id, epochHeight, ledgerHash){
    let canon = eq.buildEquivCanonical(eq.ENGINE_TAGS.ROLLCALL, String(epochHeight), 0,
                                       NETWORK + '|' + epochHeight + '|' + ledgerHash);
    return crypto.sign(null, Buffer.from(canon, 'utf8'), id.priv).toString('hex');
}

// The v1 canonical: the same fields plus sha256(GATES) as CARRIED. Built through
// the shared helper, which is the point of the helper: the hub, this parser and
// the BTC close must produce identical bytes, and a second spelling here would
// certify this file's idea of the canonical rather than the network's.
function signForV1(id, epochHeight, ledgerHash, gates){
    let canon = buildRollcallCanonical({ network: NETWORK, epochHeight, ledgerHash, gates });
    return crypto.sign(null, Buffer.from(canon, 'utf8'), id.priv).toString('hex');
}

// params[0] is VERSION; actions/index.js splits the wire string this way.
function paramsFor(over){
    let o = Object.assign({ epoch: EPOCH, ledger: LEDGER, publisher: null, sigs: [], count: null }, over || {});
    let pub = o.publisher === null ? o.sigs[0].pubkey : o.publisher;
    let p = ['ROLLCALL', String(o.epoch), o.ledger, pub,
             String(o.count === null ? o.sigs.length : o.count)];
    for(let s of o.sigs) p.push(s.pubkey, s.sig);
    return p;
}

// v1 inserts GATES between PUBLISHER and SIG_COUNT and shifts the pairs one
// field right; everything else is the v0 shape.
function paramsForV1(over){
    let o = Object.assign({ epoch: EPOCH, ledger: LEDGER, publisher: null, gates: GATES,
                            sigs: [], count: null }, over || {});
    let pub = o.publisher === null ? o.sigs[0].pubkey : o.publisher;
    let p = ['ROLLCALL', String(o.epoch), o.ledger, pub, o.gates,
             String(o.count === null ? o.sigs.length : o.count)];
    for(let s of o.sigs) p.push(s.pubkey, s.sig);
    return p;
}

// getTestConfig() force-sets INDEXER_COIN=BTC and returns the config MODULE's
// single cached object, so every mock indexer shares one config. Mutating it in
// place leaks into every later test in the file (which is how the first draft of
// this suite turned "wrong chain" into six spurious failures). Each test gets its
// own shallow copy instead, and ROLLCALL is DOGE-judged, so DOGE is the default.
function mockIndexer(coin){
    let indexer = createMockIndexer();
    indexer.config = Object.assign({}, indexer.config, { COIN: coin || 'DOGE', NETWORK: NETWORK });
    // insertRollcallSigners postdates the shared mock db, so stub it here.
    indexer.indexerDb.insertRollcallSigners = sinon.stub().resolves(0);
    return indexer;
}

async function run(params, dataOver, coin){
    let indexer = mockIndexer(coin);
    let handler = new Rollcall(indexer);
    let data = createBaseData(Object.assign({ FORMAT: 0, BLOCK_INDEX: 100, ACTION_INDEX: 1 }, dataOver || {}));
    let out = await handler.parse(params, data, null);
    return { out, indexer };
}

module.exports = {
    EPOCH, GATES, LEDGER, NETWORK, Rollcall, identity, mockIndexer, paramsFor,
    paramsForV1, rca, rga, run, signFor, signForV1,
};
