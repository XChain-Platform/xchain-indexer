// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const { createMockIndexer } = require('../../fixtures/mocks');

const Xexec   = require('../../../src/actions/xexec.js');
const ed25519 = require('../../../src/ed25519.js');
const eq      = require('../../../src/equivocation_header.js');

const PUBKEY_A = 'a'.repeat(64);
const SIG_A    = '1'.repeat(128);
const CALL_ID  = 'c'.repeat(64);

describe('Xexec (XEXEC) @regression @tier3', function () {
    let indexer, actionsCtx, handler, executeStub;

    // A dispatch row mirroring the hub's cross_chain_calls phase='dispatch' shape.
    // BTC is THIS chain, so it is the call's TARGET here.
    function makeDispatch(overrides = {}) {
        return {
            id:                    7,
            call_id:               CALL_ID,
            phase:                 'dispatch',
            snapshot_block:        150,
            network:               'regtest',
            source_chain:          'DOGE',
            source_action_index:   41,
            source_contract_index: 5,
            target_chain:          'BTC',
            target_contract_index: 99,
            method:                'onArrival',
            params_json:           '["x","y"]',
            gas_limit:             50000,
            cross_hops:            1,
            effective_time:        1700000000,
            status:                'finalized',
            validator_signatures:  JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG_A }]),
            ...overrides,
        };
    }

    const ctx = () => ({ ACTION: 'XEXEC', BLOCK_INDEX: 200, BLOCK_TIME: 1700000100 });

    beforeEach(function () {
        indexer = createMockIndexer();
        const db = indexer.indexerDb;
        db.hasCapability                  = sinon.stub().resolves(true);
        db.getValidatorsByCapability      = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
        // regtest activates STAKE_WEIGHTED_QUORUM at genesis, so parse() takes the
        // stake-weighted branch. One validator = one source: 3·tally(100) > 2·S(100) iff
        // that signer is valid — reproduces the single-validator legacy outcome.
        db.getStakeWeightsByCapability    = sinon.stub().resolves([{ pubkey: PUBKEY_A, source: 'S1', weight: '100' }]);
        db.recordCrossChainCallExecution  = sinon.stub().resolves();
        db.createSavepoint                = sinon.stub().resolves('sp1');
        db.releaseSavepoint               = sinon.stub().resolves();
        db.rollbackToSavepoint            = sinon.stub().resolves();

        // The injected EXECUTE: default to a successful run that surfaces a
        // return value + billed gas the way actions/execute.js does.
        executeStub = { parse: sinon.stub().callsFake(async (params, data) => {
            data['STATUS']           = 'valid';
            data['VM_RETURN_VALUE']  = '"hello"';
            data['VM_GAS_BILLED']    = 12345;
        }) };

        actionsCtx = {
            config:        indexer.config,
            util:          indexer.util,
            mapper:        indexer.mapper,
            decoderDb:     indexer.decoderDb,
            indexerDb:     indexer.indexerDb,
            actionExecute: executeStub,
        };
        handler = new Xexec(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    it('verifies sigs over the dispatch canonical, runs the target at depth 0 under the caller-funded ceiling', async function () {
        const stub = sinon.stub(ed25519, 'verify').returns(true);
        const d = makeDispatch();
        await handler.parse(null, Object.assign(ctx(), { CALL: d }), null);

        const expectedRaw = [
            'XCALL', 'DISPATCH', CALL_ID, '150', 'regtest', 'DOGE', '41', '5', 'BTC', '99',
            'onArrival', crypto.createHash('sha256').update('["x","y"]', 'utf8').digest('hex'),
            '50000', '1', '1700000000'
        ].join('|');
        // EQUIV active in regtest: TAG=XCALL, ROUND_ID=sha256('XCALLROUND|dispatch|'+call_id), VIEW=0.
        const expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL,
            crypto.createHash('sha256').update('XCALLROUND|dispatch|' + CALL_ID, 'utf8').digest('hex'), 0, expectedRaw);
        assert.strictEqual(stub.firstCall.args[0], expected);

        const [params, data] = executeStub.parse.firstCall.args;
        assert.deepStrictEqual(params, [0, 99, 'onArrival', 'x', 'y']);
        assert.strictEqual(data['CALL_DEPTH'], 0);
        assert.strictEqual(data['VM_GAS_LIMIT'], 50000);
        assert.strictEqual(data['CROSS_HOPS'], 1);
        assert.strictEqual(data['IS_CROSS_CALL'], true);
        assert.strictEqual(data['SOURCE'], 'C:DOGE:5');     // the calling contract, cross-chain addressed
        // Synthetic, chain/network-namespaced TX_HASH.
        assert.strictEqual(data['TX_HASH'],
            crypto.createHash('sha256').update('XCALL:regtest:BTC:' + CALL_ID, 'utf8').digest('hex'));
    });

    it('records the execution outcome (ok + capped base64 payload) OUTSIDE the run savepoint', async function () {
        sinon.stub(ed25519, 'verify').returns(true);
        await handler.parse(null, Object.assign(ctx(), { CALL: makeDispatch() }), null);
        const rec = indexer.indexerDb.recordCrossChainCallExecution;
        assert.ok(rec.calledOnce);
        const [, callId, , status, payloadB64, gasUsed, blockIndex] = rec.firstCall.args;
        assert.strictEqual(callId, CALL_ID);
        assert.strictEqual(status, 'ok');
        assert.strictEqual(Buffer.from(payloadB64, 'base64').toString('utf8'), '"hello"');
        assert.strictEqual(gasUsed, 12345);
        assert.strictEqual(blockIndex, 200);
        assert.ok(indexer.indexerDb.releaseSavepoint.calledOnce);
    });

    it('a failed run rolls back its state but the FAILURE is the recorded result (never a skip)', async function () {
        sinon.stub(ed25519, 'verify').returns(true);
        executeStub.parse.callsFake(async (params, data) => {
            data['STATUS']           = 'reverted';
            data['VM_ERROR_MESSAGE'] = 'revert: nope';
            data['VM_GAS_BILLED']    = 50000;
        });
        await handler.parse(null, Object.assign(ctx(), { CALL: makeDispatch() }), null);
        assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce);
        const [, , , status] = indexer.indexerDb.recordCrossChainCallExecution.firstCall.args;
        assert.strictEqual(status, 'reverted');
    });

    it('maps the failure families deterministically (incl. the crossCallable marker)', async function () {
        sinon.stub(ed25519, 'verify').returns(true);
        const cases = [
            [{ STATUS: 'reverted', VM_ERROR_MESSAGE: 'XCALL_NOT_CALLABLE: method "m"' }, 'not_callable'],
            [{ STATUS: 'failed',   VM_ERROR_MESSAGE: 'error: XCALL_NOT_CALLABLE: method "m"' }, 'not_callable'],
            [{ STATUS: 'out_of_resource', VM_ERROR_MESSAGE: 'out_of_gas: used 50000 of 50000' }, 'out_of_gas'],
            [{ STATUS: 'invalid: CONTRACT_ACTION_INDEX (unknown)' }, 'no_contract'],
            [{ STATUS: 'failed', VM_ERROR_MESSAGE: 'error: boom' }, 'error'],
        ];
        for (const [outcome, expected] of cases) {
            indexer.indexerDb.recordCrossChainCallExecution.resetHistory();
            executeStub.parse.callsFake(async (params, data) => Object.assign(data, outcome));
            await handler.parse(null, Object.assign(ctx(), { CALL: makeDispatch() }), null);
            const [, , , status] = indexer.indexerDb.recordCrossChainCallExecution.firstCall.args;
            assert.strictEqual(status, expected, JSON.stringify(outcome));
        }
    });

    it('an oversize return becomes payload_too_large with an EMPTY payload (state stands)', async function () {
        sinon.stub(ed25519, 'verify').returns(true);
        executeStub.parse.callsFake(async (params, data) => {
            data['STATUS']          = 'valid';
            data['VM_RETURN_VALUE'] = '"' + 'p'.repeat(1100) + '"';
            data['VM_GAS_BILLED']   = 1;
        });
        await handler.parse(null, Object.assign(ctx(), { CALL: makeDispatch() }), null);
        assert.ok(indexer.indexerDb.releaseSavepoint.calledOnce, 'state changes stand');
        const [, , , status, payloadB64] = indexer.indexerDb.recordCrossChainCallExecution.firstCall.args;
        assert.strictEqual(status, 'payload_too_large');
        assert.strictEqual(payloadB64, '');
    });

    it('refuses insufficient signatures (no execution, no record — the call stays pending)', async function () {
        sinon.stub(ed25519, 'verify').returns(false);
        await handler.parse(null, Object.assign(ctx(), { CALL: makeDispatch() }), null);
        assert.ok(executeStub.parse.notCalled);
        assert.ok(indexer.indexerDb.recordCrossChainCallExecution.notCalled);
    });

    it('defers when the capability snapshot is not mirrored yet', async function () {
        // Empty BOTH sets — the stake-weighted branch (active on regtest) reads
        // getStakeWeightsByCapability; clearing only the legacy set would not defer.
        indexer.indexerDb.getValidatorsByCapability.resolves([]);
        indexer.indexerDb.getStakeWeightsByCapability.resolves([]);
        await handler.parse(null, Object.assign(ctx(), { CALL: makeDispatch() }), null);
        assert.ok(executeStub.parse.notCalled);
        assert.ok(indexer.indexerDb.recordCrossChainCallExecution.notCalled);
    });

    it('skips another network\'s dispatch and calls not targeting this chain', async function () {
        sinon.stub(ed25519, 'verify').returns(true);
        await handler.parse(null, Object.assign(ctx(), { CALL: makeDispatch({ network: 'mainnet' }) }), null);
        await handler.parse(null, Object.assign(ctx(), { CALL: makeDispatch({ target_chain: 'LTC' }) }), null);
        assert.ok(executeStub.parse.notCalled);
    });

    it('a thrown execution still records an error result after rolling back', async function () {
        sinon.stub(ed25519, 'verify').returns(true);
        executeStub.parse.rejects(new Error('worker died'));
        await handler.parse(null, Object.assign(ctx(), { CALL: makeDispatch() }), null);
        assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce);
        const [, , , status] = indexer.indexerDb.recordCrossChainCallExecution.firstCall.args;
        assert.strictEqual(status, 'error');
    });
});
