// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Pin the ROLLCALL builder and both signer checks to the frozen vector the hub also asserts.
// Authoritative copy: xchain-documentation/protocol/test-vectors/rollcall_canonical.json.

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');
const { buildRollcallCanonical, gatesHash } = require('../../../../src/actions/rollcall/rollcall_canonical.js');
const { verifyRollcallSigners } = require('../../../../src/actions/rollcall/signatures.js');
const { verifySigners } = require('../../../../src/consensus/rollcall_close/signer_verify.js');
const ed25519 = require('../../../../src/consensus/ed25519.js');
const rga     = require('../../../../src/consensus/gates/rollcall_gates_gate.js');

const VECTORS = require('../../../fixtures/rollcall_canonical_vectors.json');
const V0 = VECTORS.canonical;
const V1 = VECTORS.canonical_v1;

const CANON_PATH   = path.resolve(__dirname, '../../../../../xchain-documentation/protocol/test-vectors/rollcall_canonical.json');
const FIXTURE_PATH = path.resolve(__dirname, '../../../fixtures/rollcall_canonical_vectors.json');

function pairs(signers){
    return signers.map(s => ({ pubkey: s.pubkey, sig: s.sig }));
}

// One close-side answer row per signer, carrying the vector's ledger hash and,
// for a v1 epoch, the carried GATES string.
function closeAnswer(signers, gates){
    const rows = {};
    for(const s of signers)
        rows[s.pubkey] = { sig: s.sig, ledger_hash: V0.ledger_hash, gates: gates === undefined ? null : gates };
    return { signers: rows };
}

function sourceMap(signers){
    return new Map(signers.map((s, i) => [s.pubkey, 'source-' + i]));
}

describe('ROLLCALL canonical vectors byte-identity to xchain-documentation @regression', function () {
    it('fixture is byte-identical to xchain-documentation/protocol/test-vectors/rollcall_canonical.json', function () {
        const verdict = siblingCheckout(__dirname, CANON_PATH);
        if (!verdict.usable)
            return skipOrFail(this, verdict, 'the canonical ROLLCALL vectors byte-identity guard');
        assert.strictEqual(fs.readFileSync(FIXTURE_PATH, 'utf8'), fs.readFileSync(CANON_PATH, 'utf8'),
            'this repo\'s rollcall_canonical_vectors.json has drifted from the canonical ' +
            'xchain-documentation/protocol/test-vectors/rollcall_canonical.json; reconcile both copies.');
    });
});

describe('ROLLCALL canonical builder against the frozen vectors @regression', function () {
    it('rebuilds the v0 canonical byte for byte', function () {
        const built = buildRollcallCanonical({ network: V0.network, epochHeight: V0.epoch_height, ledgerHash: V0.ledger_hash });
        assert.strictEqual(built, V0.expected);
    });

    it('hashes the carried GATES string to the vector gates_hash', function () {
        assert.strictEqual(Buffer.byteLength(V1.gates, 'utf8'), V1.gates_bytes);
        assert.strictEqual(gatesHash(V1.gates), V1.gates_hash);
    });

    it('rebuilds the v1 canonical byte for byte', function () {
        const built = buildRollcallCanonical({ network: V1.network, epochHeight: V1.epoch_height, ledgerHash: V1.ledger_hash, gates: V1.gates });
        assert.strictEqual(built, V1.expected);
    });

    it('every vector signature verifies over the expected canonical and every invalid case does not', function () {
        for(const s of VECTORS.signers)
            assert.strictEqual(ed25519.verify(Buffer.from(V0.expected, 'utf8'), s.sig, s.pubkey), true, 'v0 ' + s.pubkey);
        for(const s of VECTORS.signers_v1)
            assert.strictEqual(ed25519.verify(Buffer.from(V1.expected, 'utf8'), s.sig, s.pubkey), true, 'v1 ' + s.pubkey);
        for(const c of VECTORS.invalid.concat(VECTORS.invalid_v1))
            assert.strictEqual(ed25519.verify(Buffer.from(c.canonical, 'utf8'), c.sig, c.pubkey), c.verifies, c.name);
    });
});

describe('ROLLCALL parser signer check against the frozen vectors @regression', function () {
    const v0Fields = { network: V0.network, epochHeight: V0.epoch_height, ledgerHash: V0.ledger_hash };
    const v1Fields = Object.assign({}, v0Fields, { gates: V1.gates });

    it('accepts every v0 vector signature', function () {
        const out = verifyRollcallSigners(v0Fields, pairs(VECTORS.signers));
        assert.strictEqual(out.error, null);
        assert.deepStrictEqual(out.verified.map(s => s.pubkey), VECTORS.signers.map(s => s.pubkey));
    });

    it('accepts every v1 vector signature with the carried GATES', function () {
        const out = verifyRollcallSigners(v1Fields, pairs(VECTORS.signers_v1));
        assert.strictEqual(out.error, null);
        assert.deepStrictEqual(out.verified.map(s => s.pubkey), VECTORS.signers_v1.map(s => s.pubkey));
    });

    it('rejects the invalid cases: other ledger hash, network and epoch', function () {
        const sigs = pairs(VECTORS.signers.slice(0, 1));
        for(const over of [{ ledgerHash: '0'.repeat(64) }, { network: 'testnet' }, { epochHeight: 60 }]){
            const out = verifyRollcallSigners(Object.assign({}, v0Fields, over), sigs);
            assert.strictEqual(out.error, 'invalid: SIG_COUNT', JSON.stringify(over));
            assert.deepStrictEqual(out.verified, []);
        }
    });

    it('rejects the invalid_v1 cases: gates stripped, v0 signature at v1, different GATES list', function () {
        const v1Sigs = pairs(VECTORS.signers_v1);
        const v0Sigs = pairs(VECTORS.signers);
        assert.strictEqual(verifyRollcallSigners(v0Fields, v1Sigs).error, 'invalid: SIG_COUNT');
        assert.strictEqual(verifyRollcallSigners(v1Fields, v0Sigs).error, 'invalid: SIG_COUNT');
        const otherGates = Object.assign({}, v0Fields, { gates: V1.gates + ',extra_gate.EXTRA_ACTIVATION' });
        assert.strictEqual(verifyRollcallSigners(otherGates, v1Sigs).error, 'invalid: SIG_COUNT');
    });
});

describe('ROLLCALL close signer check against the frozen vectors @regression', function () {
    let savedGates;
    before(function () { savedGates = rga.ROLLCALL_GATES_ACTIVATION[V0.network]; });
    after(function () { rga.ROLLCALL_GATES_ACTIVATION[V0.network] = savedGates; });

    it('counts every v0 vector signer at a v0 epoch', function () {
        rga.ROLLCALL_GATES_ACTIVATION[V0.network] = null;
        const keys = VECTORS.signers.map(s => s.pubkey);
        const out = verifySigners(closeAnswer(VECTORS.signers), keys, sourceMap(VECTORS.signers),
            V0.ledger_hash, V0.network, V0.epoch_height);
        assert.strictEqual(out.gatesActive, false);
        assert.deepStrictEqual(out.presentKeys, keys);
        assert.deepStrictEqual(out.dropped, { no_row: 0, ledger_hash: 0, form: 0, sig: 0 });
    });

    it('counts every v1 vector signer at a v1 epoch and records the carried GATES', function () {
        rga.ROLLCALL_GATES_ACTIVATION[V1.network] = 0;
        const keys = VECTORS.signers_v1.map(s => s.pubkey);
        const out = verifySigners(closeAnswer(VECTORS.signers_v1, V1.gates), keys, sourceMap(VECTORS.signers_v1),
            V1.ledger_hash, V1.network, V1.epoch_height);
        assert.strictEqual(out.gatesActive, true);
        assert.deepStrictEqual(out.presentKeys, keys);
        assert.deepStrictEqual(out.gatesRows.map(r => r.gates.join(',')), keys.map(() => V1.gates));
    });

    it('drops a v1 signature presented with the GATES stripped at a v0 epoch', function () {
        rga.ROLLCALL_GATES_ACTIVATION[V0.network] = null;
        const keys = VECTORS.signers_v1.map(s => s.pubkey);
        const out = verifySigners(closeAnswer(VECTORS.signers_v1), keys, sourceMap(VECTORS.signers_v1),
            V0.ledger_hash, V0.network, V0.epoch_height);
        assert.deepStrictEqual(out.presentKeys, []);
        assert.strictEqual(out.dropped.sig, keys.length);
    });

    it('drops a v1 signature over a different GATES list at a v1 epoch', function () {
        rga.ROLLCALL_GATES_ACTIVATION[V1.network] = 0;
        const keys = VECTORS.signers_v1.map(s => s.pubkey);
        const other = V1.gates + ',extra_gate.EXTRA_ACTIVATION';
        const out = verifySigners(closeAnswer(VECTORS.signers_v1, other), keys, sourceMap(VECTORS.signers_v1),
            V1.ledger_hash, V1.network, V1.epoch_height);
        assert.deepStrictEqual(out.presentKeys, []);
        assert.strictEqual(out.dropped.sig, keys.length);
    });
});
