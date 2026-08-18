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
 * test/unit/actions/batch-execute-attest.test.js
 *
 * TWO-EXECUTE BATCH ATTEST regression.
 *
 * The defect: batch.js bounds BATCH/MINT/ISSUE only, so a BATCH may carry any
 * number of EXECUTE subcommands; actions.js assigns TX_VOUT once per TRANSACTION;
 * and every subcommand is its own ROOT execution, seeding call-path ''. Two EXECUTE
 * subcommands against the SAME contract therefore fed the request_id preimage
 * (tx_hash, TX_VOUT, '', contract_index, 0) twice and derived the IDENTICAL
 * request_id for their first attestation. db.createAttestationRequest saw the prior
 * row, warned and returned WITHOUT inserting, so the second execution ran bound to
 * the FIRST request's provider, payload and callback while its own value stayed
 * escrowed against no row of its own.
 *
 * The remedy is the per-subcommand root discriminator (flag-day gated; see
 * test/unit/batchRootDiscriminatorGate.test.js for the registration). This suite is
 * the end-to-end regression the defect never had: the REAL Batch handler stamps the
 * positions, the REAL discriminator turns them into root tokens, and the REAL ATTEST
 * v0 handler accepts each resulting request_id, which it does only when its own
 * re-derivation reproduces the id byte for byte.
 *
 * The VM half of the byte-match (the gateway that actually hashes these preimages)
 * is pinned against the same literal hexes in
 * xchain-vm/test/determinism/crossrepo-request-call-id-bytematch.test.js, and
 * bin/check-preimage-golden-parity.js fails CI if either side loses its pin.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Batch  = require('../../../src/actions/batch.js');
const Attest = require('../../../src/actions/attest.js');
const swq    = require('../../../src/stake_weighted_quorum.js');
const attestAdmission = require('../../../src/attest_admission_activation.js');
const { rootDiscriminator } = require('../../../src/batch_root_discriminator.js');

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

// Cross-repo golden pins for the COMPOSITE root form, the shape this regression is
// about. Literal on purpose: the same two hexes are asserted against the real VM
// gateway in xchain-vm/test/determinism/crossrepo-request-call-id-bytematch.test.js,
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

describe('two-EXECUTE BATCH ATTEST request_id collision @regression @tier1', function(){

    let indexer, actionsCtx, batch;

    beforeEach(function(){
        indexer = createMockIndexer();
        actionsCtx = {
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
        batch = new Batch(actionsCtx);
        indexer.util.resetLists();
        indexer.indexerDb.isActionAllowed.resolves(true);
        // At/after BATCH_COST_WEIGHTING the R4 spam collapse prices EXECUTE at its acceptance
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
    });

    afterEach(function(){
        sinon.restore();
    });

    // Drives the real Batch handler over two same-contract EXECUTE subcommands and
    // returns what each subcommand's handler was handed. batch.js mutates ONE data
    // object across the loop, so each dispatch is snapshotted as it happens.
    async function runTwoExecuteBatch(){
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

    it('a BATCH does NOT bound EXECUTE, so two of them really do reach the handler', async function(){
        const seen = await runTwoExecuteBatch();
        assert.strictEqual(seen.length, 2);
        assert.deepStrictEqual(seen.map(s => s.action), ['EXECUTE', 'EXECUTE']);
    });

    it('both subcommands share ONE TX_VOUT, which is why TX_VOUT alone cannot name a root', async function(){
        const seen = await runTwoExecuteBatch();
        assert.strictEqual(seen[0].TX_VOUT, seen[1].TX_VOUT,
            'actions.js assigns TX_VOUT once per transaction; if this ever stops being true the ' +
            'discriminator is still correct, but the defect it fixes would have changed shape');
    });

    it('batch.js stamps each subcommand its own 0-based BATCH_POSITION', async function(){
        const seen = await runTwoExecuteBatch();
        assert.deepStrictEqual(seen.map(s => s.BATCH_POSITION), [0, 1],
            'the position is the only content-derived value that separates the two roots');
    });

    it('the two roots derive DISTINCT request_ids with the gate ON', async function(){
        const seen  = await runTwoExecuteBatch();
        const ids   = seen.map(s => deriveReqId(TX_HASH,
            rootDiscriminator(s.TX_VOUT, s.BATCH_POSITION, true), '', CONTRACT, 0));
        assert.notStrictEqual(ids[0], ids[1],
            'two same-contract EXECUTE subcommands must no longer produce one request_id');
    });

    it('the two roots COLLIDE with the gate OFF, which is the history replay must reproduce', async function(){
        const seen = await runTwoExecuteBatch();
        const ids  = seen.map(s => deriveReqId(TX_HASH,
            rootDiscriminator(s.TX_VOUT, s.BATCH_POSITION, false), '', CONTRACT, 0));
        assert.strictEqual(ids[0], ids[1],
            'below the flag day the preimage is the historical one, collision included; a node ' +
            'that "fixed" this ungated would derive request_ids mainnet never wrote');
    });

    it('golden vector: the composite roots hash to the checked-in cross-repo hexes', function(){
        for(const [root, expected] of Object.entries(GOLDEN_BATCH_REQUEST_IDS))
            assert.strictEqual(deriveReqId('abc123', root, '', 7, 0), expected,
                'composite request_id preimage drifted; xchain-vm/src/gateway.js must move in lockstep');
    });

    describe('the REAL ATTEST v0 handler accepts each subcommand request', function(){

        let attest, attestCtx;

        beforeEach(function(){
            const db = indexer.indexerDb;
            db.getContract                       = sinon.stub().resolves({ contract_index: CONTRACT });
            db.createAttestationRequest          = sinon.stub().resolves();
            db.getAttestationAdmissionCounts = sinon.stub().resolves({ total: 0, byContract: 0 });
            db.getAttestationRequestById         = sinon.stub().resolves(null);
            db.hasCapability                     = sinon.stub().resolves(true);
            db.getValidatorsByCapability         = sinon.stub().resolves([{ pubkey: 'a'.repeat(64) }]);
            db.getStakeWeightsByCapability       = sinon.stub().resolves([{ pubkey: 'a'.repeat(64), source: 'SA', weight: '100' }]);
            attestCtx = {
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
            attest = new Attest(attestCtx);
            // Same defaults the ATTEST suite uses: legacy count path, admission gate off,
            // so a redundancy-3 request against a one-validator snapshot stays 'valid'.
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
            sinon.stub(attestAdmission, 'isAttestAdmissionActive').returns(false);
        });

        // ATTEST v0 as execute.processEmission stamps it for a subcommand's first emission.
        function v0(root, requestId){
            const data = createBaseData({
                ACTION: 'ATTEST', FORMAT: 0, IS_EMISSION: true, TX_HASH, TX_VOUT,
                EMITTER: CONTRACT, EMITTER_POSITION: 0, EMITTER_PATH: '',
                ROOT_ACTION_INDEX: root, BLOCK_INDEX: 100,
            });
            const params = ['0', requestId, 'http_get', 'q', 'onResult', '[]', '3', '50'];
            return { data, params };
        }

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
    });
});
