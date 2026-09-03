'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Guard-inert sub-commands inside a pre-flighted BATCH.
 *
 * The asymmetry this closes, measured on testnet 2026-09-02 (defect D-E059): with a
 * transfer controller bound to an address, the STANDALONE `SEND` from that address
 * pre-flighted as guardInert (valid:null, "we did not judge this") and landed valid on
 * chain, while the IDENTICAL send as a BATCH sub-command came back as a hard error -
 * `DRYRUN_SUBCOMMAND_INVALID ... invalid: FEE_QUOTE_CONTROLLER_UNSUPPORTED`. Same
 * refusal, two opposite presentations, and the batch one is a false NEGATIVE: it tells
 * a composer the chain will reject a command the chain in fact accepts.
 *
 * The cause is that the sentinel reaches the sub-command collector as an ordinary
 * `invalid: ...` status string, and the SDK's classifier (preflight/index.js
 * classifySubCommands) buckets every non-empty status as invalid. The refusal is not a
 * verdict, so it belongs in the UNJUDGED bucket that already exists for exactly this
 * shape (a VM sub-action the probe declines to dispatch), with a `refused` note that
 * names the controller responsible.
 ********************************************************************/

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const Utility = require('../../src/utility.js');
const Actions = require('../../src/actions.js');
const Batch   = require('../../src/actions/batch.js');
const PreflightMemo = require('../../src/preflightMemo.js');
const { createMockIndexer, createBaseData } = require('../fixtures/mocks');

const SOURCE   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DEST     = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const FEE_DEST = 'feeDestinationAddr111111111111111';
const BASE     = { BLOCK_INDEX: 100, ACTION_INDEX: 5, SOURCE: 'addr1' };

function mkActions(guardResult, calls, guardEnabled){
    return {
        protocolChanges: { isEnabled: async () => (guardEnabled === undefined ? true : guardEnabled) },
        actionExecute:   { runControllerGuard: async (o) => { calls.push(o); return guardResult; } }
    };
}

function mkTokenDb(effective){
    return {
        config: { GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: 200000 }, GAS_PRICE: '0.00001', GAS: 'XCHAIN' },
        getTickerId: async () => 1,
        getEffectiveTokenControllerForGuard: async () => effective
    };
}

function mkAddressDb(effective){
    return {
        config: { GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: 200000 }, GAS_PRICE: '0.00001', GAS: 'XCHAIN' },
        getAddressId: async () => 1,
        getEffectiveAddressControllerForGuard: async () => effective
    };
}

describe('BATCH pre-flight : a guard-inert sub-command is UNJUDGED, not invalid @regression @tier1', function () {

    const util = new Utility();

    describe('the sentinel names the controller that caused it', function () {

        it('a token-controller refusal names the contract, class and token', async function () {
            const res = await util.maybeRunControllerGuard(
                mkActions({ allow: true, reason: null, gasBilled: 1000 }, [], true),
                mkTokenDb({ contract_index: 9, is_unbind: 0 }),
                { actionType: 'SEND', tick: 'AAA', from: 'addr1', to: 'addr2', amount: '10',
                  data: Object.assign({}, BASE, { GUARD_INERT: true }), gasInfo: null, gasBalances: [] }
            );
            assert.ok(util.isGuardInertError(res.error), 'the sentinel must still be recognizable: ' + res.error);
            assert.ok(res.error.indexOf('contract 9') !== -1, 'names the controller contract: ' + res.error);
            assert.ok(res.error.indexOf('transfer') !== -1, 'names the gated action class: ' + res.error);
            assert.ok(res.error.indexOf('AAA') !== -1, 'names the controlled token: ' + res.error);
        });

        it('an address-controller refusal names the contract, class and address', async function () {
            const res = await util.maybeRunAddressControllerGuard(
                mkActions({ allow: true, reason: null, gasBilled: 1000 }, [], true),
                mkAddressDb({ contract_index: 12, is_unbind: 0 }),
                { actionType: 'SEND', actionClass: 'transfer', address: SOURCE, from: SOURCE, to: DEST,
                  tick: 'AAA', amount: '10',
                  data: Object.assign({}, BASE, { GUARD_INERT: true }), gasInfo: null, gasBalances: [] }
            );
            assert.ok(util.isGuardInertError(res.error), 'the sentinel must still be recognizable: ' + res.error);
            assert.ok(res.error.indexOf('contract 12') !== -1, 'names the controller contract: ' + res.error);
            assert.ok(res.error.indexOf(SOURCE) !== -1, 'names the bound address: ' + res.error);
        });

        it('isGuardInertError still matches the bare legacy sentinel and rejects everything else', function () {
            assert.strictEqual(util.isGuardInertError('FEE_QUOTE_CONTROLLER_UNSUPPORTED'), true);
            assert.strictEqual(util.isGuardInertError('invalid: FEE_QUOTE_CONTROLLER_UNSUPPORTED (contract 9)'), true);
            assert.strictEqual(util.isGuardInertError('invalid: insufficient funds'), false);
            assert.strictEqual(util.isGuardInertError(null), false);
            assert.strictEqual(util.isGuardInertError(undefined), false);
            assert.strictEqual(util.isGuardInertError(''), false);
        });
    });

    describe('batch.js probe collector', function () {
        let indexer, actionsCtx, handler;

        // The verdict the SEND handler records when its bound controller's guard cannot run on
        // the public probe (send.js: error = 'invalid: ' + result.error).
        const INERT = 'invalid: FEE_QUOTE_CONTROLLER_UNSUPPORTED (contract 9 controls transfer for address '
                    + SOURCE + ')';

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = {
                config:          indexer.config,
                util:            indexer.util,
                mapper:          indexer.mapper,
                decoderDb:       indexer.decoderDb,
                indexerDb:       indexer.indexerDb,
                protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
                actionAliases:   { TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' },
                // The first SEND is controller-bound and comes back guard-inert; the second is an
                // ordinary send that really was judged.
                processAction:   sinon.stub().callsFake(async (action, params, data) => {
                    data['STATUS'] = (params[1] === 'CTRL') ? INERT : 'valid';
                })
            };
            handler = new Batch(actionsCtx);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.util.resetLists();
        });

        afterEach(function () { sinon.restore(); });

        const WIRE = 'BATCH|0|SEND|0|CTRL|10|' + DEST + ';SEND|0|TEST|5|' + DEST;

        function probeData(){
            return createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA: WIRE, FEE_PROBE: true });
        }

        it('reports the guard-inert sub-command as UNJUDGED, never as a rejection', async function () {
            const data = probeData();
            await handler.parse(['0'], data, null);

            const v = data['PROBE_SUB_VERDICTS'];
            assert.strictEqual(v.length, 2);
            assert.strictEqual(v[0].status, null,
                'a refusal to enter the controller VM is not a verdict, so it must not read as invalid');
            assert.ok(v[0].refused, 'the guard-inert row must say why it has no verdict');
        });

        it('the refusal note names the controller as the cause', async function () {
            const data = probeData();
            await handler.parse(['0'], data, null);

            const note = data['PROBE_SUB_VERDICTS'][0].refused;
            assert.ok(note.indexOf('contract 9') !== -1, 'names the controller contract: ' + note);
            assert.ok(note.indexOf('controller') !== -1, 'says a controller is the cause: ' + note);
        });

        it('leaves an ordinary sub-command verdict untouched', async function () {
            const data = probeData();
            await handler.parse(['0'], data, null);

            assert.deepStrictEqual(
                data['PROBE_SUB_VERDICTS'][1],
                { position: 1, action: 'SEND', status: 'valid', refused: null });
        });

        it('a genuinely invalid sub-command is still reported invalid', async function () {
            actionsCtx.processAction = sinon.stub().callsFake(async (action, params, data) => {
                data['STATUS'] = 'invalid: insufficient funds';
            });
            handler = new Batch(actionsCtx);
            const data = probeData();
            await handler.parse(['0'], data, null);

            assert.strictEqual(data['PROBE_SUB_VERDICTS'][0].status, 'invalid: insufficient funds');
            assert.strictEqual(data['PROBE_SUB_VERDICTS'][0].refused, null);
        });

        it('BELOW-PROBE CONTROL: consensus dispatch is untouched by the translation', async function () {
            // The collector only exists on the probe path, so a decoded transaction carrying the
            // same wire keeps the handler's literal status. (The sentinel is itself unreachable
            // off the probe path - only the synthetic tx sets GUARD_INERT.)
            const data = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA: WIRE });
            await handler.parse(['0'], data, null);
            assert.strictEqual(data['PROBE_SUB_VERDICTS'], undefined);
            assert.strictEqual(data['STATUS'], 'valid');
        });
    });

    describe('computeFeeQuote / computePreflight name the controller too', function () {

        function makeCtx(dryRun){
            let u = new Utility();
            u.config['COIN']    = 'BTC';
            u.config['ADDRESS'] = Object.assign({}, u.config['ADDRESS'] || {}, { FEE_DESTINATION: FEE_DEST });
            return {
                config:    u.config,
                util:      u,
                indexerDb: { getLatestBlockIndex: async () => 100, getBlockTime: async () => 1000 },
                actionAliases: {},
                _preflightMemo: new PreflightMemo(4),
                _feeQuotePending: 0,
                _dryRunAction: async () => Object.assign(
                    { blockIndex: 100, blockTime: 1000, status: 'valid', error: null, xchainFee: '0',
                      sourceFeeBalance: null, subCommands: null, oracleFeesOwed: null }, dryRun || {}),
                _nativeFeeMandatory: Actions.prototype._nativeFeeMandatory,
                _batchProbeForbiddenSubAction: Actions.prototype._batchProbeForbiddenSubAction,
                computeFeeQuote:  Actions.prototype.computeFeeQuote,
                computePreflight: Actions.prototype.computePreflight,
                _staticFeeQuote:  Actions.prototype._staticFeeQuote
            };
        }

        const STATUS = 'invalid: FEE_QUOTE_CONTROLLER_UNSUPPORTED (contract 9 controls transfer for address '
                     + SOURCE + ')';

        it('the fee-quote refusal quotes the controller detail', async function () {
            let ctx = makeCtx({ status: STATUS });
            let r = await ctx.computeFeeQuote({ action: 'SEND', params: '0|CTRL|1|' + DEST, source: SOURCE });
            assert.strictEqual(r.supported, false);
            assert.ok(r.error.indexOf('contract 9') !== -1, 'names the controller: ' + r.error);
        });

        it('the pre-flight carries a readable guardInertReason naming the controller', async function () {
            let ctx = makeCtx({ status: STATUS });
            let r = await ctx.computePreflight({ action: 'SEND', params: '0|CTRL|1|' + DEST, source: SOURCE });
            assert.strictEqual(r.guardInert, true);
            assert.strictEqual(r.valid, null);
            assert.ok(r.guardInertReason && r.guardInertReason.indexOf('contract 9') !== -1,
                'names the controller: ' + r.guardInertReason);
        });

        it('a non-inert pre-flight carries no guardInertReason', async function () {
            let ctx = makeCtx();
            let r = await ctx.computePreflight({ action: 'SEND', params: '0|TEST|1|' + DEST, source: SOURCE });
            assert.strictEqual(r.guardInert, false);
            assert.strictEqual(r.guardInertReason, null);
        });
    });
});
