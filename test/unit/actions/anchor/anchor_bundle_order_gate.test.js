// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { createBaseData } = require('../../../fixtures/mocks');
const {
    PUBKEY_A, PUBKEY_B, SIG, v0Params, THREE_CHAINS, armAnchor, disarmAnchor
} = require('./anchor.test/helpers/anchor_fixtures.js');
const GOLDEN = require('../../../fixtures/anchor_canonical_vectors.json');

const NETWORKS = ['mainnet', 'testnet', 'regtest'];
const LEGACY_ORDER_NETWORKS = ['mainnet', 'testnet'];

let indexer, handler, verifyStub, swqStub, deriveGateStub;

function setNetwork(network) {
    handler.config['NETWORK'] = network;
    indexer.config['NETWORK'] = network;
}

async function parseBundle(network, overrides = {}) {
    setNetwork(network);
    const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE', BLOCK_INDEX: 70000000 });
    await handler.parse(v0Params(Object.assign({}, overrides, { network })), data, null);
    return data;
}

function goldenParams() {
    const parts = GOLDEN.vectors.v0.split('|');
    assert.strictEqual(parts[0], 'ANCHOR');
    return parts.slice(1);
}

beforeEach(function () {
    ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
});

afterEach(function () {
    disarmAnchor({ verifyStub, swqStub, deriveGateStub });
});

describe('Anchor bundle legacy wire order', function () {
    for (const network of LEGACY_ORDER_NETWORKS) {
        it(`accepts DOGE before BTC on ${network}`, async function () {
            const data = await parseBundle(network, {
                sections: [{ chain: 'DOGE' }, { chain: 'BTC' }]
            });
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it(`accepts PUBKEY_B before PUBKEY_A on ${network}`, async function () {
            const data = await parseBundle(network, {
                sections: [{ chain: 'BTC', sigs: [[PUBKEY_B, SIG], [PUBKEY_A, SIG]] }]
            });
            assert.strictEqual(data['STATUS'], 'valid');
        });
    }
});

describe('Anchor bundle ascending order and ties', function () {
    for (const network of NETWORKS) {
        it(`accepts the three-chain bundle on ${network}`, async function () {
            const data = await parseBundle(network, { sections: THREE_CHAINS });
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it(`accepts repeated pubkeys on ${network}`, async function () {
            const data = await parseBundle(network, {
                sections: [{ chain: 'BTC', sigs: [[PUBKEY_A, SIG], [PUBKEY_A, SIG]] }]
            });
            assert.strictEqual(data['STATUS'], 'valid');
        });
    }
});

describe('Anchor bundle duplicate chains', function () {
    for (const network of NETWORKS) {
        it(`refuses a repeated chain on ${network}`, async function () {
            const data = await parseBundle(network, {
                sections: [{ chain: 'BTC' }, { chain: 'BTC' }]
            });
            assert.ok(String(data['STATUS']).includes('CHAIN (duplicate)'));
        });
    }
});

describe('Anchor bundle golden wire', function () {
    it('accepts the frozen v0 vector on regtest', async function () {
        setNetwork('regtest');
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE', BLOCK_INDEX: 70000000 });
        await handler.parse(goldenParams(), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });
});
