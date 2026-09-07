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
// Deferred chunked-DEPLOY assembly (DEPLOY_DEFERRED_ASSEMBLY): a chunk group deploys
// exactly once, in the block where its LAST piece confirms, whatever order the pieces
// confirm in. An assembler that lands early is PENDING; the carrier that completes the
// group runs the deployment at its own action and consumes the assembler.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const { getTestConfig } = require('../../fixtures/config');

const Deploy = require('../../../src/actions/deploy.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const CODE   = 'module.exports = { initialize: function() { return 1; } };';
const B64    = Buffer.from(CODE, 'utf8').toString('base64');
const HASH   = crypto.createHash('sha256').update(CODE).digest('hex');

// The assembler's stored rows, as db.getPendingDeployAssembler returns them. gas_limit /
// input_params come from its contract_executions row, the staking pair from its contracts row.
function assemblerRow(overrides = {}){
    return {
        action_index: 700, block_index: 100, code_hash: HASH,
        cooldown_blocks: null, slash_destination_id: null,
        gas_limit: 100000, input_params: 'x', fee_payment_mode: 2,
        ...overrides
    };
}
function carrierChunk(overrides = {}){
    return { chunk_index: 0, total_chunks: 1, code_part: B64, action_index: 902, ...overrides };
}

describe('Deferred chunked DEPLOY assembly @regression @tier2', function () {

    let indexer, ctx, db, handler, ledgerWrites;

    // gateOn / balance / chunkRows / pendingAssembler are the four axes every case below moves.
    function build({ gateOn = true, balance = '1000', chunkRows = [], pendingAssembler = null, ctorGas = 5000 } = {}){
        const config = getTestConfig();
        indexer = createMockIndexer({ config });
        db = indexer.indexerDb;
        for(const m of ['createContract','createContractPermission','deleteContract','createContractExecution',
                        'createContractState','releaseSavepoint','rollbackToSavepoint','recordDeployChunk','createAddress'])
            db[m] = sinon.stub().resolves();
        db.createSavepoint        = sinon.stub().resolves('sp1');
        db.getOracleDataForVM     = sinon.stub().resolves({});
        db.getCrossChainDataForVM = sinon.stub().resolves({});
        db.getPollResultsForVM    = sinon.stub().resolves({ polls: {} });
        db.getStatusString        = sinon.stub().resolves('valid');
        db.getAddressById         = sinon.stub().resolves(null);
        db.isActionAllowed.resolves(true);
        db.getTokenInfo.resolves({ TICK_ID: 1 });
        db.getAddressBalances.resolves({ 1: balance });
        // The assembly bound is honoured for real: rows at or above `before` are not returned,
        // which is what makes the C + 1 bound observable.
        db.getDeployChunksForAssembly = sinon.stub().callsFake(async (src, hash, before) =>
            chunkRows.filter(r => Number(r.action_index) < Number(before)));
        db.getPendingDeployAssembler  = sinon.stub().resolves(pendingAssembler);

        const isEnabled = sinon.stub().resolves(true);
        isEnabled.withArgs('DEPLOY_DEFERRED_ASSEMBLY', sinon.match.any).resolves(gateOn);

        // Capture each ledger write of this action BEFORE consolidation, so a split write is
        // visible as two entries rather than hiding inside one consolidated row.
        ledgerWrites = [];
        const realLedger = indexer.util.processTransactionLedgerChanges.bind(indexer.util);
        indexer.util.processTransactionLedgerChanges = async (d, data, credits, debits, escrows) => {
            ledgerWrites.push({ action: String(data['ACTION_INDEX']), debits: debits.map(x => x.slice()) });
            return realLedger(d, data, credits, debits, escrows);
        };

        ctx = {
            config: indexer.config, util: indexer.util, mapper: indexer.mapper,
            decoderDb: indexer.decoderDb, indexerDb: db,
            protocolChanges: { isEnabled },
            vm: {
                validateSyntax:     sinon.stub().returns({ valid: true }),
                checkFloatWarnings: sinon.stub().returns([]),
                readManifest:       sinon.stub().resolves({ success: true, manifest: { hasInitialize: true, permissionsType: 'undefined', maxTakeBpsType: 'undefined' } }),
                execute:            sinon.stub().resolves({ success: true, gasUsed: ctorGas, stateChanges: [], stateDeletes: [], emittedActions: [] })
            }
        };
        indexer.util.resetLists();
        handler = new Deploy(ctx);
    }

    afterEach(function () { sinon.restore(); });

    function assemblerData(overrides = {}){
        return createBaseData({ ACTION: 'DEPLOY', FORMAT: 2, SOURCE, BLOCK_INDEX: 100, ACTION_INDEX: 700, ...overrides });
    }
    function carrierData(overrides = {}){
        return createBaseData({ ACTION: 'DEPLOY', FORMAT: 4, SOURCE, BLOCK_INDEX: 100, ACTION_INDEX: 902, ...overrides });
    }
    const execRow = () => db.createContractExecution.firstCall.args[0];
    const contractRow = () => db.createContract.firstCall.args[0];
    const totalDebited = () => ledgerWrites.reduce((n, w) => n + w.debits.length, 0);

    describe('R2: the assembler lands', function () {

        it('lands PENDING under the DECLARED hash with empty code when the group is incomplete', async function () {
            build({ chunkRows: [] });
            const data = assemblerData();
            await handler.parse(['2', HASH, '100000', 'x'], data, null);
            assert.strictEqual(data['STATUS'], 'pending: CODE_HASH (awaiting chunks)');
            assert.strictEqual(contractRow().STATUS, 'pending: CODE_HASH (awaiting chunks)');
            assert.strictEqual(contractRow().CODE_HASH, HASH);   // NOT sha256('')
            assert.strictEqual(contractRow().CODE, '');
        });

        it('charges the base gas at the assembler and records the mode it paid in', async function () {
            build({ chunkRows: [] });
            await handler.parse(['2', HASH, '100000', 'x'], assemblerData(), null);
            assert.strictEqual(Number(execRow().GAS_USED), 100000);          // VM_DEPLOY_BASE
            assert.strictEqual(Number(execRow().GAS_LIMIT), 100000);
            assert.strictEqual(execRow().INPUT_PARAMS, 'x');
            assert.strictEqual(execRow().FEE_PAYMENT_MODE, 2);
            assert.strictEqual(execRow().ASSEMBLER_ACTION_INDEX, null);
            assert.strictEqual(ledgerWrites.length, 1);
            assert.strictEqual(ledgerWrites[0].debits.length, 1);
            assert.strictEqual(String(ledgerWrites[0].debits[0][1]), '1');   // 100000 * 0.00001
        });

        it('creates no address, no state and no permissions, and runs no VM code', async function () {
            build({ chunkRows: [] });
            await handler.parse(['2', HASH, '100000', 'x'], assemblerData(), null);
            assert.strictEqual(db.createAddress.callCount, 0);
            assert.strictEqual(db.createContractState.callCount, 0);
            assert.strictEqual(db.createContractPermission.callCount, 0);
            assert.strictEqual(ctx.vm.execute.callCount, 0);
            assert.strictEqual(ctx.vm.validateSyntax.callCount, 0);
        });

        it('rejects a second assembler while one is pending, and charges it nothing', async function () {
            build({ chunkRows: [], pendingAssembler: assemblerRow() });
            const data = assemblerData({ ACTION_INDEX: 800 });
            await handler.parse(['2', HASH, '100000', 'x'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: CODE_HASH (duplicate pending)');
            assert.strictEqual(totalDebited(), 0);
        });

        it('deploys inline and unchanged when the group is already complete from lower carriers', async function () {
            build({ chunkRows: [carrierChunk({ action_index: 10 })] });
            const data = assemblerData();
            await handler.parse(['2', HASH, '100000', 'x'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(Number(contractRow().ACTION_INDEX), 700);
            assert.strictEqual(execRow().ASSEMBLER_ACTION_INDEX, null);
            assert.strictEqual(db.getPendingDeployAssembler.callCount, 0);
        });

        it('lets the fee-mode reject win over the chunk verdict', async function () {
            build({ chunkRows: [] });
            // A native-fee chain with no fee output: post-activation the fee check runs BEFORE
            // the pending landing, so this assembler is rejected rather than parked pending.
            indexer.util.detectFeePaymentMode = () => 'rejected';
            const data = assemblerData();
            await handler.parse(['2', HASH, '100000', 'x'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient fee (native coin output required)');
        });

        it('lets the sleeping reject win over the chunk verdict', async function () {
            build({ chunkRows: [] });
            db.isActionAllowed.resolves(false);
            const data = assemblerData();
            await handler.parse(['2', HASH, '100000', 'x'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: SOURCE (sleeping)');
        });

        it('is unchanged below the flag day: an early assembler is invalid and pays no gas', async function () {
            build({ gateOn: false, chunkRows: [] });
            const data = assemblerData();
            await handler.parse(['2', HASH, '100000', 'x'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: CODE_HASH (no chunks)');
            assert.strictEqual(db.getPendingDeployAssembler.callCount, 0);
            assert.strictEqual(totalDebited(), 0);
        });
    });

    describe('R1 + R3: the carrier that completes the group deploys it', function () {

        it('deploys at the completing carrier with the assembler recorded on the execution row', async function () {
            build({ chunkRows: [carrierChunk()], pendingAssembler: assemblerRow() });
            const data = carrierData();
            await handler.parse(['4', HASH, '0', '1', B64], data, null);
            assert.strictEqual(contractRow().CODE, CODE);
            assert.strictEqual(contractRow().CODE_HASH, HASH);
            assert.strictEqual(contractRow().STATUS, 'valid');
            assert.strictEqual(Number(contractRow().ACTION_INDEX), 902);
            assert.strictEqual(Number(execRow().ACTION_INDEX), 902);
            assert.strictEqual(Number(execRow().CONTRACT_INDEX), 902);
            assert.strictEqual(execRow().ASSEMBLER_ACTION_INDEX, 700);
            // The contract's permanent derived address is the COMPLETING action's (D1).
            assert.ok(db.createAddress.getCalls().some(c => c.args[0] === 'C:BTC:902'));
            // The carrier keeps its own verdict; the deployment's lives on the contract rows.
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('takes the wire parameters from the assembler and the transaction context from the carrier', async function () {
            // slash_destination_id is stored as an address id and must round-trip back to the
            // address createContract re-interns.
            build({ chunkRows: [carrierChunk()], pendingAssembler: assemblerRow({ gas_limit: 77000, input_params: 'a|b', cooldown_blocks: 50, slash_destination_id: 9 }) });
            db.getAddressById.resolves('mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM');
            await handler.parse(['4', HASH, '0', '1', B64], carrierData(), null);
            assert.strictEqual(Number(execRow().GAS_LIMIT), 77000);
            assert.strictEqual(execRow().INPUT_PARAMS, 'a|b');
            assert.strictEqual(Number(contractRow().COOLDOWN_BLOCKS), 50);
            assert.strictEqual(contractRow().SLASH_DESTINATION, 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM');
            assert.deepStrictEqual(ctx.vm.execute.firstCall.args[0].params, ['a', 'b']);
            assert.strictEqual(ctx.vm.execute.firstCall.args[0].contractAddress, 'C:BTC:902');
            assert.strictEqual(ctx.vm.execute.firstCall.args[0].actionIndex, 902);
        });

        it('assembles from a bound that INCLUDES the completing carrier and excludes anything above it', async function () {
            build({ chunkRows: [carrierChunk({ chunk_index: 0, total_chunks: 2 }),
                                carrierChunk({ chunk_index: 1, total_chunks: 2, action_index: 903 })],
                    pendingAssembler: assemblerRow() });
            await handler.parse(['4', HASH, '0', '2', B64], carrierData(), null);
            assert.strictEqual(Number(db.getDeployChunksForAssembly.firstCall.args[2]), 903);
            // Position 1 sits ABOVE this carrier, so the group is still incomplete: nothing deploys.
            assert.strictEqual(db.createContract.callCount, 0);
        });

        it('writes the carrier fee and the deployment fee in ONE ledger call', async function () {
            build({ chunkRows: [carrierChunk()], pendingAssembler: assemblerRow() });
            await handler.parse(['4', HASH, '0', '1', B64], carrierData(), null);
            assert.strictEqual(ledgerWrites.length, 1);
            assert.strictEqual(ledgerWrites[0].action, '902');
            assert.strictEqual(ledgerWrites[0].debits.length, 2);
            // The carrier's own per-byte fee, then the constructor gas only: the base component
            // was charged at the assembler, so it is not charged again here.
            assert.strictEqual(String(ledgerWrites[0].debits[1][1]), '0.05');  // 5000 * 0.00001
            assert.strictEqual(Number(execRow().GAS_USED), 5000);
        });

        it('rejects at the carrier when the source was drained between the assembler and here', async function () {
            // Enough for the carrier's own fee, far short of min(GAS_LIMIT, GAS_CEILING) * GAS_PRICE.
            build({ balance: '0.4', chunkRows: [carrierChunk()], pendingAssembler: assemblerRow() });
            const data = carrierData();
            await handler.parse(['4', HASH, '0', '1', B64], data, null);
            assert.strictEqual(contractRow().STATUS, 'invalid: insufficient funds (GAS)');
            assert.strictEqual(ctx.vm.execute.callCount, 0);         // the constructor never ran
            assert.strictEqual(execRow().ASSEMBLER_ACTION_INDEX, 700); // the assembler is still consumed
            // Only the carrier's own fee is debited, and it is one the source actually holds:
            // a debit it never had would drop the ledger supply and trip the SanityError.
            assert.strictEqual(ledgerWrites.length, 1);
            assert.strictEqual(ledgerWrites[0].debits.length, 1);
            assert.strictEqual(String(ledgerWrites[0].debits[0][1]), '0.008');
        });

        it('consumes the assembler when the assembled bytes do not match the declared hash', async function () {
            const wrong = carrierChunk({ code_part: Buffer.from('module.exports = {};', 'utf8').toString('base64') });
            build({ chunkRows: [wrong], pendingAssembler: assemblerRow() });
            const data = carrierData();
            await handler.parse(['4', HASH, '0', '1', wrong.code_part], data, null);
            assert.strictEqual(contractRow().STATUS, 'invalid: CODE_HASH (assembly mismatch)');
            assert.strictEqual(execRow().ASSEMBLER_ACTION_INDEX, 700);
            assert.strictEqual(data['STATUS'], 'valid');   // the carrier itself was fine
        });

        it('completes nothing from an INVALID carrier', async function () {
            build({ chunkRows: [carrierChunk()], pendingAssembler: assemblerRow() });
            const data = carrierData();
            await handler.parse(['4', HASH, '5', '1', B64], data, null);   // CHUNK_INDEX out of range
            assert.strictEqual(data['STATUS'], 'invalid: CHUNK_INDEX (out of range)');
            assert.strictEqual(db.createContract.callCount, 0);
            assert.strictEqual(db.getPendingDeployAssembler.callCount, 0);
        });

        it('completes nothing when no assembler is pending (a duplicate slice after the deploy)', async function () {
            build({ chunkRows: [carrierChunk()], pendingAssembler: null });
            await handler.parse(['4', HASH, '0', '1', B64], carrierData(), null);
            assert.strictEqual(db.createContract.callCount, 0);
            assert.strictEqual(db.getDeployChunksForAssembly.callCount, 0);
        });

        it('charges nothing further at the carrier when the assembler paid natively', async function () {
            build({ chunkRows: [carrierChunk()], pendingAssembler: assemblerRow({ fee_payment_mode: 1 }) });
            indexer.util.detectFeePaymentMode = () => 'native';
            indexer.util.validateNativeCoinFee = async () => ({ valid: true, nativeCoinAmount: '0.001', nativeCoin: 'BTC', oracleRound: 7 });
            await handler.parse(['4', HASH, '0', '1', B64], carrierData(), null);
            assert.strictEqual(contractRow().STATUS, 'valid');
            assert.strictEqual(execRow().FEE_PAYMENT_MODE, 1);
            assert.strictEqual(totalDebited(), 0);   // native: neither leg debits XCHAIN
        });

        it('is unchanged below the flag day: a carrier never looks for an assembler', async function () {
            build({ gateOn: false, chunkRows: [carrierChunk()], pendingAssembler: assemblerRow() });
            await handler.parse(['4', HASH, '0', '1', B64], carrierData(), null);
            assert.strictEqual(db.getPendingDeployAssembler.callCount, 0);
            assert.strictEqual(db.createContract.callCount, 0);
        });
    });
});
