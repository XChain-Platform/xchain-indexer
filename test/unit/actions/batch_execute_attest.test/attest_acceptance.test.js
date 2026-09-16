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
 * Real ATTEST acceptance for two EXECUTE subcommands. One part of
 * batch_execute_attest.test.js; the shared fixtures are in
 * helpers/batch_execute_attest_suite.js.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { rootDiscriminator } = require('../../../../src/consensus/batch_root_discriminator.js');
const {
    TX_HASH, TX_VOUT, CONTRACT, deriveReqId, freshBatchSuite, v0, freshAttestSuite,
} = require('./helpers/batch_execute_attest_suite.js');

let indexer, attest, attestCtx;
function freshSuite() {
    ({ indexer } = freshBatchSuite());
    ({ attest, attestCtx } = freshAttestSuite(indexer));
}

function acceptanceCases() {
    it('accepts a composite-root request, so the host re-derivation matches the VM', async function(){
        const root  = rootDiscriminator(TX_VOUT, 1, true);
        const reqId = deriveReqId(TX_HASH, root, '', CONTRACT, 0);
        const { data, params } = v0(root, reqId);
        await attest.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid',
            'a rejection means the handler folded or reformatted the composite root and no ' +
            'longer agrees with xchain-vm/src/gateway.js');
    });

    it('rejects a request whose id was derived from the OTHER subcommand root', async function(){
        // The precise failure the discriminator prevents: subcommand 1 presenting the
        // id subcommand 0 already owns. Before the fix both subcommands legitimately
        // derived that id and the second insert was silently dropped; now the second
        // root hashes to something else and the mismatched id is refused outright.
        const wrong = deriveReqId(TX_HASH, rootDiscriminator(TX_VOUT, 0, true), '', CONTRACT, 0);
        const { data, params } = v0(rootDiscriminator(TX_VOUT, 1, true), wrong);
        await attest.parse(params, data, null);
        assert.ok(String(data['STATUS']).includes('REQUEST_ID'),
            'expected a REQUEST_ID derivation rejection, got: ' + data['STATUS']);
    });
}

function separateRequestCase() {
    it('both subcommands are inserted as SEPARATE requests', async function(){
        for(const position of [0, 1]){
            const root  = rootDiscriminator(TX_VOUT, position, true);
            const { data, params } = v0(root, deriveReqId(TX_HASH, root, '', CONTRACT, 0));
            await attest.parse(params, data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        }
        const created = attestCtx.indexerDb.createAttestationRequest;
        assert.strictEqual(created.callCount, 2);
        const ids = created.getCalls().map(c => String(c.args[0]['REQUEST_ID']));
        assert.notStrictEqual(ids[0], ids[1],
            'the second subcommand must own a request row of its own, not inherit the first');
    });
}

describe('two-EXECUTE BATCH ATTEST request_id collision @regression @tier1', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('the REAL ATTEST v0 handler accepts each subcommand request', acceptanceCases);
    describe('the REAL ATTEST v0 handler accepts each subcommand request', separateRequestCase);
});
