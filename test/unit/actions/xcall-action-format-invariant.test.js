// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Regression for review item 2748: the mirror-driven XCALL result-delivery
// pass minted its rollback-anchor action row with an explicit FORMAT of 1,
// but XCALL only declares this.formats[0] and this.formats[2] (parse()
// rejects any other value, and on-chain Version 1 does not exist for XCALL).
// That row was undecodable. The fix drops the FORMAT property entirely so
// the row stores NULL action_format, matching the versionless injected-
// anchor convention used elsewhere (CROSS_SETTLE, XEXEC).
//
// This test locks the class-level invariant: every FORMAT value a handler
// passes to indexerDb.createActionIndex is either absent/null, or a key
// present in that handler's own this.formats table. It drives both the
// mirror result-delivery path (processResult) and the deadline-expiry path
// (parse v2) and inspects every recorded createActionIndex call.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Xcall   = require('../../../src/actions/xcall.js');
const ed25519 = require('../../../src/ed25519.js');

const PUBKEY_A = 'a'.repeat(64);
const SIG_A    = '1'.repeat(128);

describe('XCALL action_format invariant (review item 2748)', function () {
    let indexer, actionsCtx, handler, executeStub, recordedCalls;

    function addXcallDbStubs(db) {
        db.getContract                        = sinon.stub().resolves({ contract_index: 5 });
        db.createCrossChainCallRequest        = sinon.stub().resolves();
        db.getCrossChainCallRequestById       = sinon.stub().resolves(null);
        db.updateCrossChainCallRequestStatus  = sinon.stub().resolves();
        db.setCrossChainCallCallbackIndex     = sinon.stub().resolves();
        db.recordCrossChainCallCallback       = sinon.stub().resolves();
        db.hasCapability                      = sinon.stub().resolves(true);
        db.getValidatorsByCapability          = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
        db.getStakeWeightsByCapability        = sinon.stub().resolves([{ pubkey: PUBKEY_A, source: 'S1', weight: '100' }]);
        db.createSavepoint                    = sinon.stub().resolves('sp1');
        db.releaseSavepoint                   = sinon.stub().resolves();
        db.rollbackToSavepoint                = sinon.stub().resolves();

        // Wrap createActionIndex so every mint call's FORMAT argument is captured,
        // independent of which code path (result-delivery vs expiry) triggers it.
        recordedCalls = [];
        db.createActionIndex = sinon.stub().callsFake(async (action) => {
            recordedCalls.push(action);
            return recordedCalls.length;
        });
    }

    function makeRequestRow(overrides = {}) {
        return {
            call_id:               'c'.repeat(64),
            contract_index:        5,
            target_chain:          'DOGE',
            target_contract_index: 99,
            method:                'onArrival',
            params_json:           '["x"]',
            gas_limit:             50000,
            cross_hops:            1,
            callback_method:       'onResult',
            callback_params_json:  '["ctx"]',
            deadline_block:        300,
            request_status:        'pending',
            block_index:           100,
            ...overrides,
        };
    }

    function makeResultRow(overrides = {}) {
        return {
            call_id:              'c'.repeat(64),
            phase:                'result',
            snapshot_block:       150,
            network:              'regtest',
            source_chain:         'BTC',
            target_chain:         'DOGE',
            result_status:        'ok',
            return_payload_b64:   Buffer.from('"42"', 'utf8').toString('base64'),
            effective_time:       1700000000,
            validator_signatures: JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG_A }]),
            ...overrides,
        };
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        addXcallDbStubs(indexer.indexerDb);
        executeStub = { parse: sinon.stub().resolves() };
        actionsCtx = {
            config:        indexer.config,
            util:          indexer.util,
            mapper:        indexer.mapper,
            decoderDb:     indexer.decoderDb,
            indexerDb:     indexer.indexerDb,
            actionExecute: executeStub,
        };
        handler = new Xcall(actionsCtx);
        indexer.util.resetLists();
        sinon.stub(ed25519, 'verify').returns(true);
    });

    afterEach(function () {
        sinon.restore();
    });

    // The class-level invariant asserted below, applied to every recorded call.
    function assertFormatInvariant(action, label) {
        const declared = handler.formats || {};
        const hasFormat = Object.prototype.hasOwnProperty.call(action, 'FORMAT') && action['FORMAT'] !== null;
        if (!hasFormat) return; // absent/null FORMAT always satisfies the invariant
        assert.ok(
            Object.prototype.hasOwnProperty.call(declared, action['FORMAT']),
            `${label}: createActionIndex was called with FORMAT ${action['FORMAT']}, ` +
            `but XCALL only declares formats [${Object.keys(declared).join(', ')}]`
        );
    }

    it('mirror result-delivery mint carries no FORMAT (or one XCALL declares)', async function () {
        indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
        await handler.processResult(makeResultRow(), { BLOCK_INDEX: 200, BLOCK_TIME: 1700000100 });

        assert.ok(recordedCalls.length >= 1, 'expected at least one createActionIndex call');
        for (const action of recordedCalls) assertFormatInvariant(action, 'processResult');

        // Pin the specific fix: the rollback-anchor mint for XCALL result-delivery
        // must not carry FORMAT: 1 (undecodable; only formats 0 and 2 exist).
        const anchorCall = recordedCalls.find(a => a['ACTION'] === 'XCALL' && a['BLOCK_INDEX'] === 200);
        assert.ok(anchorCall, 'expected an XCALL rollback-anchor createActionIndex call at BLOCK_INDEX 200');
        assert.ok(
            !Object.prototype.hasOwnProperty.call(anchorCall, 'FORMAT') || anchorCall['FORMAT'] === null,
            'XCALL result-delivery rollback anchor must not mint with an explicit FORMAT (got FORMAT: ' + anchorCall['FORMAT'] + ')'
        );
    });

    it('deadline-expiry mint (v2) carries the declared FORMAT 2, satisfying the invariant', async function () {
        indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
        const data = createBaseData({
            ACTION: 'XCALL', FORMAT: 2, IS_SYNTHETIC: true,
            CALL_ID: 'c'.repeat(64), BLOCK_INDEX: 301,
        });
        await handler.parse(['2', 'c'.repeat(64)], data, null);

        assert.ok(recordedCalls.length >= 1, 'expected at least one createActionIndex call');
        for (const action of recordedCalls) assertFormatInvariant(action, 'parse v2 (expiry)');

        const anchorCall = recordedCalls.find(a => a['ACTION'] === 'XCALL' && a['BLOCK_INDEX'] === 301);
        assert.ok(anchorCall, 'expected an XCALL createActionIndex call at BLOCK_INDEX 301');
        assert.strictEqual(anchorCall['FORMAT'], 2);
    });

    it('sentinel: the invariant helper actually fails on a FORMAT value the handler does not declare', function () {
        // Guards against a vacuous invariant check: if this call regressed to
        // FORMAT: 1 the assertion above would throw. Prove that here directly.
        assert.throws(() => assertFormatInvariant({ ACTION: 'XCALL', FORMAT: 1 }, 'sentinel'), /createActionIndex was called with FORMAT 1/);
    });
});
