'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

const assert = require('assert');
const checkpoint = require('../../../../src/consensus/snapshot_checkpoint/canonical.js');

const pubkey = (digit) => String(digit).repeat(64);
const signature = (key) => key + key;
const base = {
    chain: 'BTC',
    network: 'testnet',
    block_index: 100,
    block_hash: 'A'.repeat(64),
    state_root: 'B'.repeat(64),
    state_root_version: 2,
};
const trustSet = [1, 2, 3, 4].map((digit) => ({
    pubkey: pubkey(digit),
    weight: '1',
    source: 'source-' + digit,
}));

function signedBy(...digits) {
    return Object.assign({}, base, {
        validator_signatures: digits.map((digit) => ({
            pubkey: pubkey(digit),
            sig: signature(pubkey(digit)),
        })),
    });
}

function verify(canonical, sig, key) {
    return canonical === checkpoint.snapshotCheckpointCanonical(base) && sig === signature(key);
}

describe('snapshot checkpoint canonical', function () {
    it('writes the literal domain-separated canonical bytes', function () {
        assert.strictEqual(checkpoint.SNAPSHOT_CHECKPOINT_TAG, 'XSNAPCKPT');
        assert.strictEqual(
            checkpoint.snapshotCheckpointCanonical(base),
            `XSNAPCKPT|BTC|testnet|100|${'a'.repeat(64)}|${'b'.repeat(64)}|2`
        );
        assert.ok(!checkpoint.snapshotCheckpointCanonical(base).startsWith('XCHECKPOINT'));
    });

    it('refuses non-BTC chains, unsafe block indexes, and malformed hashes', function () {
        assert.throws(() => checkpoint.snapshotCheckpointCanonical(Object.assign({}, base, { chain: 'LTC' })));
        for (const block_index of ['100', 1.5, Number.MAX_SAFE_INTEGER + 1])
            assert.throws(() => checkpoint.snapshotCheckpointCanonical(Object.assign({}, base, { block_index })));
        assert.throws(() => checkpoint.snapshotCheckpointCanonical(Object.assign({}, base, { block_hash: 'g'.repeat(64) })));
        assert.throws(() => checkpoint.snapshotCheckpointCanonical(Object.assign({}, base, { state_root: 'a'.repeat(63) })));
    });

    it('uses the buried capability snapshot height on every network', function () {
        for (const network of ['mainnet', 'testnet', 'regtest'])
            assert.strictEqual(checkpoint.snapshotCheckpointBlock(106, network), 100);
    });

    it('forms the snapshot round id', function () {
        assert.strictEqual(checkpoint.snapshotCheckpointRoundId(base), 'SNAP|BTC|testnet|100');
    });
});

describe('snapshot checkpoint quorum', function () {
    it('accepts strictly more than two thirds of the stake', function () {
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(signedBy(1, 2, 3), trustSet, verify), true);
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(signedBy(1, 2), trustSet, verify), false);
    });

    it('accepts validator_signatures as JSON text', function () {
        const cp = signedBy(1, 2, 3);
        cp.validator_signatures = JSON.stringify(cp.validator_signatures);
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(cp, trustSet, verify), true);
    });

    it('does not count duplicate or untrusted keys', function () {
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(signedBy(1, 1, 2), trustSet, verify), false);
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(signedBy(1, 2, 9), trustSet, verify), false);
    });

    it('adds a key to seen only after one of its signatures verifies', function () {
        const cp = signedBy(1, 2, 3);
        cp.validator_signatures.unshift({ pubkey: pubkey(1), sig: '0'.repeat(128) });
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(cp, trustSet, verify), true);
    });

    it('ignores malformed signatures and verifier failures', function () {
        const cp = signedBy(1, 2, 3);
        cp.validator_signatures.unshift(
            { pubkey: 'x'.repeat(64), sig: '0'.repeat(128) },
            { pubkey: pubkey(4), sig: 'short' }
        );
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(cp, trustSet, verify), true);
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(signedBy(1, 2, 3), trustSet, () => { throw new Error('bad signature'); }), false);
    });

    it('fails closed on empty or malformed trust and signature sets', function () {
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(signedBy(1, 2, 3), [], verify), false);
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(signedBy(1, 2, 3), [{ pubkey: pubkey(1) }], verify), false);
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(Object.assign({}, base, { validator_signatures: '{' }), trustSet, verify), false);
        assert.strictEqual(checkpoint.snapshotCheckpointQuorum(Object.assign({}, base, { validator_signatures: {} }), trustSet, verify), false);
    });
});
