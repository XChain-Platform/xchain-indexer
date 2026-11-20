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
 **********************************************************************
 * test/unit/cross_chain/malformed_signature_columns.test.js
 *
 * The canonical quorum verifier reads a validator_signatures column that parses as JSON
 * of the wrong shape as zero valid signers. These cases pin that existing guard.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');

const { verifyMatchQuorum, verifyCanonicalQuorum } = require('../../../src/actions/cross_settle/quorum.js');
const { verifyDispatchQuorum } = require('../../../src/actions/xexec/dispatch_quorum.js');
const Xcall = require('../../../src/actions/xcall/index.js');

const PUBKEY = 'b'.repeat(64);

// A single-validator snapshot, served for both the weighted and the count read so the test
// does not depend on which side of the quorum gate the row's height falls.
function snapshotDb(pubkey = PUBKEY){
    let validators = [{ pubkey, source: 'validator-1', weight: '1' }];
    return {
        getValidatorsByCapability:  async () => validators,
        getStakeWeightsByCapability: async () => validators
    };
}

const MALFORMED = ['null', '{}', '5', '"x"', 'true', '[null]', '[5]', '["x"]', '[[]]', '{"pubkey":"a"}'];

describe('canonical quorum signature shape guard @regression @tier1', function () {

    for(let text of MALFORMED){
        it('canonical quorum reads the column ' + text + ' as no signers without throwing', async function () {
            let q = await verifyCanonicalQuorum(snapshotDb(), 'canonical', text, 1, 'regtest');
            assert.strictEqual(q.met, false);
            assert.strictEqual(q.snapshotAbsent, false);
        });

        it('match quorum reads the column ' + text + ' as no signers without throwing', async function () {
            let verdict = {};
            let met = await verifyMatchQuorum.call({
                indexerDb: snapshotDb(),
                canonical: () => 'canonical'
            }, {
                snapshot_block: 1,
                network: 'regtest',
                match_id: 'ab'.repeat(32),
                validator_signatures: text
            }, verdict);
            assert.strictEqual(met, false);
            assert.notStrictEqual(verdict.snapshotAbsent, true);
        });

        it('dispatch quorum reads the column ' + text + ' as no signers without throwing', async function () {
            let q = await verifyDispatchQuorum.call({
                indexerDb: snapshotDb(),
                canonical: () => 'canonical'
            }, {
                snapshot_block: 1,
                network: 'regtest',
                validator_signatures: text
            });
            assert.strictEqual(q.synced, true);
            assert.strictEqual(q.quorumMet, false);
            assert.deepStrictEqual(q.validSigners, []);
        });

        it('result quorum reads the column ' + text + ' as no signers without throwing', async function () {
            let q = await Xcall.prototype.verifyResultQuorum.call({
                indexerDb: snapshotDb(),
                resultCanonical: () => 'canonical'
            }, {
                snapshot_block: 1,
                network: 'regtest',
                validator_signatures: text
            });
            assert.strictEqual(q.synced, true);
            assert.strictEqual(q.quorumMet, false);
            assert.deepStrictEqual(q.validSigners, []);
        });
    }

    it('preserves a valid one-validator quorum in all four verifiers', async function () {
        const canonical = 'canonical';
        const pair = crypto.generateKeyPairSync('ed25519');
        const pubkey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
        const sig = crypto.sign(null, Buffer.from(canonical), pair.privateKey).toString('hex');
        const validatorSignatures = JSON.stringify([{ pubkey, sig }]);
        const db = snapshotDb(pubkey);
        const row = { snapshot_block: 1, network: 'regtest', match_id: 'ab'.repeat(32), validator_signatures: validatorSignatures };

        const canonicalResult = await verifyCanonicalQuorum(db, canonical, validatorSignatures, 1, 'regtest');
        assert.strictEqual(canonicalResult.met, true);
        assert.strictEqual(await verifyMatchQuorum.call({ indexerDb: db, canonical: () => canonical }, row, {}), true);
        const dispatch = await verifyDispatchQuorum.call({ indexerDb: db, canonical: () => canonical }, row);
        assert.strictEqual(dispatch.quorumMet, true);
        assert.deepStrictEqual(dispatch.validSigners, [pubkey]);
        const result = await Xcall.prototype.verifyResultQuorum.call({
            indexerDb: db,
            resultCanonical: () => canonical
        }, row);
        assert.strictEqual(result.quorumMet, true);
        assert.deepStrictEqual(result.validSigners, [pubkey]);
    });
});
