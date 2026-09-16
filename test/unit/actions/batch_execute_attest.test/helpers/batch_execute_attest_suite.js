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
 * Shared fixtures for batch_execute_attest.test.js and its part in
 * test/unit/actions/batch_execute_attest.test/.
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const Batch  = require('../../../../../src/actions/batch/index.js');
const Attest = require('../../../../../src/actions/attest/index.js');
const swq    = require('../../../../../src/stake_weighted_quorum.js');
const { stubActiveAt } = require('../../../../helpers/gate_modules.js');

const SOURCE   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const TX_HASH  = 'a'.repeat(64);
const TX_VOUT  = 0;
const CONTRACT = 7;

// The request_id preimage, written out here the way the VM writes it
// (xchain-vm/src/gateway.js attestation.request). ROOT is hashed as the raw string
// it arrives as: NEVER Number()-coerced, or '3.10' and '3.1' fold together.
const deriveReqId = (txHash, root, emitterPath, contractIndex, position) =>
    crypto.createHash('sha256')
        .update(String(txHash) + ':' + String(root) + ':' + String(emitterPath) + ':' + String(contractIndex) + ':' + String(position))
        .digest('hex');

function freshBatchSuite() {
    const indexer = createMockIndexer();
    const actionsCtx = {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
        processAction:   sinon.stub().resolves(),
        actionAliases:   { TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' },
    };
    const batch = new Batch(actionsCtx);
    indexer.util.resetLists();
    // At/after BATCH_COST_WEIGHTING the aggregate spam collapse prices EXECUTE at its acceptance
    // floor (batch.js vmBaseFeeActions), so a two-EXECUTE batch from a source that cannot
    // cover it collapses to ONE invalid record and no sub-command reaches a handler. Every
    // gate is ON in this fixture, so the SOURCE is funded and the GAS token seeded: these
    // tests are about ROOT DERIVATION, and what they claim is that a BATCH does not bound
    // EXECUTE BY COUNT, which is exactly as true for a source that pays its way. Left to
    // the bare mock they would keep passing only because its GAS token does not exist,
    // which is an incidental reason and would break on the next fixture change.
    indexer.indexerDb.getTokenInfo
        .withArgs('XCHAIN', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'XCHAIN', TICK_ID: 1, DECIMALS: 8 }));
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
    return { indexer, actionsCtx, batch };
}

// Drives the real Batch handler over two same-contract EXECUTE subcommands and
// returns what each subcommand's handler was handed. batch.js mutates ONE data
// object across the loop, so each dispatch is snapshotted as it happens.
async function runTwoExecuteBatch(suite) {
    const { actionsCtx, batch } = suite;
    const commands = 'EXECUTE|0|' + CONTRACT + '|ping|;EXECUTE|0|' + CONTRACT + '|pong|';
    const data = createBaseData({
        ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_HASH, TX_VOUT,
        TX_DATA: 'BATCH|0|' + commands,
    });
    const seen = [];
    actionsCtx.processAction.callsFake(async (action, params, d) => {
        seen.push({ action, TX_VOUT: d['TX_VOUT'], BATCH_POSITION: d['BATCH_POSITION'] });
    });
    await batch.parse(['0', commands], data, null);
    assert.strictEqual(data['STATUS'], 'valid', 'fixture must be a valid two-command BATCH');
    return seen;
}

// ATTEST v0 as execute.processEmission stamps it for a subcommand's first emission.
function v0(root, requestId) {
    const data = createBaseData({
        ACTION: 'ATTEST', FORMAT: 0, IS_EMISSION: true, TX_HASH, TX_VOUT,
        EMITTER: CONTRACT, EMITTER_POSITION: 0, EMITTER_PATH: '',
        ROOT_ACTION_INDEX: root, BLOCK_INDEX: 100,
    });
    const params = ['0', requestId, 'http_get', 'q', 'onResult', '[]', '3', '50'];
    return { data, params };
}

function freshAttestSuite(indexer) {
    const db = indexer.indexerDb;
    db.getContract                       = sinon.stub().resolves({ contract_index: CONTRACT });
    db.createAttestationRequest          = sinon.stub().resolves();
    db.getAttestationAdmissionCounts     = sinon.stub().resolves({ total: 0, byContract: 0 });
    db.getAttestationRequestById         = sinon.stub().resolves(null);
    db.hasCapability                     = sinon.stub().resolves(true);
    db.getValidatorsByCapability         = sinon.stub().resolves([{ pubkey: 'a'.repeat(64) }]);
    db.getStakeWeightsByCapability       = sinon.stub().resolves([{ pubkey: 'a'.repeat(64), source: 'SA', weight: '100' }]);
    const attestCtx = {
        config:        indexer.config,
        util:          indexer.util,
        mapper:        indexer.mapper,
        decoderDb:     indexer.decoderDb,
        indexerDb:     db,
        actionExecute: { parse: sinon.stub().resolves() },
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
    };
    const attest = new Attest(attestCtx);
    // Same defaults the ATTEST suite uses: legacy count path, admission gate off,
    // so a redundancy-3 request against a one-validator snapshot stays 'valid'.
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    stubActiveAt(sinon, 'attest_admission_activation.ATTEST_ADMISSION_ACTIVATION', false);
    return { attest, attestCtx };
}

module.exports = {
    SOURCE, TX_HASH, TX_VOUT, CONTRACT, deriveReqId,
    freshBatchSuite, runTwoExecuteBatch, v0, freshAttestSuite,
};
