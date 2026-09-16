'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// AnchorRecovery quorum tally: verify-then-mark ordering in _quorumVerified, pinned
// against the same crafted signature lists as its hub twin. Part of the suite whose
// entry is test/unit/recovery.test.js.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const AnchorRecovery = require('../../../../bin/recovery.js');

// Publisher-faithful archive builder and the database stubs, shared with the
// suite entry test/unit/recovery.test.js.
const { makeKeypair, signHex } = require('../../../fixtures/anchor-archive.js');
const { util, memDb } = require('../../../helpers/recovery_stubs.js');

// Fresh federation keys for every test. Held at module scope so the fixture
// builders in this file read the current test's keys, exactly as they did when
// the whole suite was one describe block.
let oracleKeys, crossKeys;
function freshKeys() {
    oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    crossKeys  = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
}
const quiet = { log: () => {}, util };

const CANON = 'XCHECKPOINTV1|recovery-parity-probe';
const BAD   = 'ab'.repeat(64);   // well-formed hex, verifies against nothing

// Four equal-weight sources: 3 of 4 clears both the weighted 3*tally > 2*S
// bar and the legacy 2f+1 count, 2 of 4 clears neither.
function setOf(keys) {
    return keys.map((k, i) => ({ pubkey: k.pubkey, source: 'src' + i, weight: '100' }));
}
function rec() {
    return new AnchorRecovery(memDb([], []), quiet);
}

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    beforeEach(freshKeys);

    // Pkg 13 / the recovery tally marks a pubkey into the dedupe set only
    // after its signature verifies. This is the consumer twin of the hub finalizer
    // (StateAnchorPublisher._quorumVerified, pinned by its own test), so
    // the two must agree on the same crafted list or a rebuilt node and a live hub
    // would reach opposite verdicts on the same archived batch.
    describe('_quorumVerified verify-then-mark ordering (Pkg 13 twin parity)', function () {
        it('counts a qualified signer whose valid sig is ordered AFTER a garbage one', function () {
            let keys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
            let set  = setOf(keys);
            let sigs = [
                { pubkey: keys[0].pubkey, sig: BAD },                       // garbage first
                { pubkey: keys[0].pubkey, sig: signHex(keys[0], CANON) },   // the real one, second
                { pubkey: keys[1].pubkey, sig: signHex(keys[1], CANON) },
                { pubkey: keys[2].pubkey, sig: signHex(keys[2], CANON) }
            ];
            assert.strictEqual(rec().quorumVerified(CANON, sigs, set, true), true,
                'weighted: the leading garbage entry must not drop a real signer');
            assert.strictEqual(rec().quorumVerified(CANON, sigs, set, false), true,
                'count: same verdict on the legacy 2f+1 path');
        });

        it('still counts a repeated valid signer ONCE (dedupe intact)', function () {
            let keys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
            let set  = setOf(keys);
            let sigs = [
                { pubkey: keys[0].pubkey, sig: signHex(keys[0], CANON) },
                { pubkey: keys[0].pubkey, sig: signHex(keys[0], CANON) },   // repeat of the same signer
                { pubkey: keys[1].pubkey, sig: signHex(keys[1], CANON) }
            ];
            assert.strictEqual(rec().quorumVerified(CANON, sigs, set, true), false,
                'a repeated signer must not inflate the stake tally to quorum');
            assert.strictEqual(rec().quorumVerified(CANON, sigs, set, false), false);
        });

        it('a signer with only garbage entries never counts, whatever the ordering', function () {
            let keys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
            let set  = setOf(keys);
            let sigs = [
                { pubkey: keys[0].pubkey, sig: BAD },
                { pubkey: keys[0].pubkey, sig: 'cd'.repeat(64) },
                { pubkey: keys[1].pubkey, sig: signHex(keys[1], CANON) },
                { pubkey: keys[2].pubkey, sig: signHex(keys[2], CANON) }
            ];
            assert.strictEqual(rec().quorumVerified(CANON, sigs, set, true), false,
                'verify gate is not weakened: two of four sources is sub-quorum');
        });
    });
});
