/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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
 * test/unit/actions/batch_execute_attest.test.js
 *
 * TWO-EXECUTE BATCH ATTEST regression.
 *
 * The defect: batch.js bounds BATCH/MINT/ISSUE only, so a BATCH may carry any
 * number of EXECUTE subcommands; actions/index.js assigns TX_VOUT once per TRANSACTION;
 * and every subcommand is its own ROOT execution, seeding call-path ''. Two EXECUTE
 * subcommands against the SAME contract therefore fed the request_id preimage
 * (tx_hash, TX_VOUT, '', contract_index, 0) twice and derived the IDENTICAL
 * request_id for their first attestation. db.createAttestationRequest saw the prior
 * row, warned and returned WITHOUT inserting, so the second execution ran bound to
 * the FIRST request's provider, payload and callback while its own value stayed
 * escrowed against no row of its own.
 *
 * The remedy is the per-subcommand root discriminator (flag-day gated; see
 * test/unit/consensus/batch_root_discriminator_gate.test.js for the registration). This suite is
 * the end-to-end regression the defect never had: the REAL Batch handler stamps the
 * positions, the REAL discriminator turns them into root tokens, and the REAL ATTEST
 * v0 handler accepts each resulting request_id, which it does only when its own
 * re-derivation reproduces the id byte for byte.
 *
 * The VM half of the byte-match (the gateway that actually hashes these preimages)
 * is pinned against the same literal hexes in
 * xchain-vm/test/determinism/crossrepo_request_call_id_bytematch.test.js, and
 * bin/check-preimage-golden-parity.js fails CI if either side loses its pin.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { rootDiscriminator } = require('../../../src/consensus/batch_root_discriminator.js');
const {
    TX_HASH, TX_VOUT, CONTRACT, deriveReqId, freshBatchSuite, runTwoExecuteBatch,
} = require('./batch_execute_attest.test/helpers/batch_execute_attest_suite.js');

// Cross-repo golden pins for the COMPOSITE root form, the shape this regression is
// about. Literal on purpose: the same two hexes are asserted against the real VM
// gateway in xchain-vm/test/determinism/crossrepo_request_call_id_bytematch.test.js,
// so a preimage edit on one side alone reddens that side instead of quietly forking
// the fleet. Inputs mirror the checked-in GOLDEN_VECTORS.requestId tuple
// (txHash 'abc123', contract 7, path '', position 0) with the root replaced by the
// composite a BATCH subcommand carries.
const GOLDEN_BATCH_REQUEST_IDS = {
    // sha256('abc123:100.0::7:0')
    '100.0': 'c72fe26cdd4f8147fc07e16eb2ea5868d879fb61b8612cbc8c6cb7fffe12e3e6',
    // sha256('abc123:100.1::7:0')
    '100.1': '0d7fba0bc1917aa1e74e90dfcce0db0a352094b0587eddc468f228a9dcca17b9',
};

let suite;
function freshSuite() {
    suite = freshBatchSuite();
}

function batchShapeCases() {
    it('a BATCH does NOT bound EXECUTE, so two of them really do reach the handler', async function(){
        const seen = await runTwoExecuteBatch(suite);
        assert.strictEqual(seen.length, 2);
        assert.deepStrictEqual(seen.map(s => s.action), ['EXECUTE', 'EXECUTE']);
    });

    it('both subcommands share ONE TX_VOUT, which is why TX_VOUT alone cannot name a root', async function(){
        const seen = await runTwoExecuteBatch(suite);
        assert.strictEqual(seen[0].TX_VOUT, seen[1].TX_VOUT,
            'actions.js assigns TX_VOUT once per transaction; if this ever stops being true the ' +
            'discriminator is still correct, but the defect it fixes would have changed shape');
    });

    it('batch.js stamps each subcommand its own 0-based BATCH_POSITION', async function(){
        const seen = await runTwoExecuteBatch(suite);
        assert.deepStrictEqual(seen.map(s => s.BATCH_POSITION), [0, 1],
            'the position is the only content-derived value that separates the two roots');
    });
}

function requestIdCases() {
    it('the two roots derive DISTINCT request_ids with the gate ON', async function(){
        const seen  = await runTwoExecuteBatch(suite);
        const ids   = seen.map(s => deriveReqId(TX_HASH,
            rootDiscriminator(s.TX_VOUT, s.BATCH_POSITION, true), '', CONTRACT, 0));
        assert.notStrictEqual(ids[0], ids[1],
            'two same-contract EXECUTE subcommands must no longer produce one request_id');
    });

    it('the two roots COLLIDE with the gate OFF, which is the history replay must reproduce', async function(){
        const seen = await runTwoExecuteBatch(suite);
        const ids  = seen.map(s => deriveReqId(TX_HASH,
            rootDiscriminator(s.TX_VOUT, s.BATCH_POSITION, false), '', CONTRACT, 0));
        assert.strictEqual(ids[0], ids[1],
            'below the flag day the preimage is the historical one, collision included; a node ' +
            'that "fixed" this ungated would derive request_ids mainnet never wrote');
    });
}

function goldenVectorCase() {
    it('golden vector: the composite roots hash to the checked-in cross-repo hexes', function(){
        for(const [root, expected] of Object.entries(GOLDEN_BATCH_REQUEST_IDS))
            assert.strictEqual(deriveReqId('abc123', root, '', 7, 0), expected,
                'composite request_id preimage drifted; xchain-vm/src/gateway.js must move in lockstep');
    });
}

describe('two-EXECUTE BATCH ATTEST request_id collision @regression @tier1', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    batchShapeCases();
    requestIdCases();
    goldenVectorCase();
});
