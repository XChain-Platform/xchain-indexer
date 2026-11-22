// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// STATE_VALUE_ASTRAL_ESCAPE: the stored contract_state.state_value text. Below the gate a
// value holding a character above U+FFFF reaches createContractState as raw JSON exactly as
// before (and halts on the utf8mb3 column); at the gate it is written with \uXXXX\uXXXX
// escape pairs that JSON.parse back to the same value. The escape spelling is pinned as a
// literal because the stored text enters contract_hash.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { STATE_VALUE_ASTRAL_ESCAPE, escapeAstral, stateValueTexts } =
    require('../../../../src/actions/execute/state_value_text.js');
const Execute = require('../../../../src/actions/execute/index.js');
const Deploy  = require('../../../../src/actions/deploy/index.js');
const { createMockIndexer } = require('../../../fixtures/mocks');
const { CONTRACT, makeVm, executeData, buildExecute } = require('../execute.test/helpers/fixture.js');
const { VALID_CODE_B64, deployData, freshDeploySuite, makeVm: makeDeployVm } =
    require('../contract/deploy.test/helpers/deploy_suite.js');

const EMOJI         = '\u{1F600}';
const ESCAPED_EMOJI = '\\ud83d\\ude00';

// An isEnabled that answers this gate as given and every other gate as active.
function gateStub(active){
    return sinon.stub().callsFake(async (name) => (name === STATE_VALUE_ASTRAL_ESCAPE ? active : true));
}

function gateCalls(stub){
    return stub.getCalls().filter((c) => c.args[0] === STATE_VALUE_ASTRAL_ESCAPE);
}

describe('STATE_VALUE_ASTRAL_ESCAPE stored text @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('writes the frozen lowercase escape pair for an astral character', function () {
        assert.strictEqual(escapeAstral(JSON.stringify(EMOJI)), '"' + ESCAPED_EMOJI + '"');
        assert.strictEqual(escapeAstral(JSON.stringify('\u{10000}\u{10FFFF}')), '"\\ud800\\udc00\\udbff\\udfff"');
    });

    it('round-trips keys, nesting, a neighbouring backslash and a lone surrogate through JSON.parse', function () {
        const values = [
            EMOJI,
            { [EMOJI]: [EMOJI, 'a' + EMOJI + 'b', 7] },
            '\\' + EMOJI + '\\',
            '\uD83D' + 'x' + EMOJI,
            EMOJI.repeat(3),
        ];
        for(const value of values){
            const text = escapeAstral(JSON.stringify(value));
            assert.ok(!/[\uD800-\uDFFF]/.test(text), 'no surrogate code unit survives raw: ' + text);
            assert.ok(/^[\u0000-￿]*$/.test(text));
            assert.deepStrictEqual(JSON.parse(text), value);
        }
    });

    it('leaves BMP-only text byte-identical, lone-surrogate escapes included', function () {
        for(const value of ['plain', { k: 'é中☃' }, '\uD83D', 12, [true, null]]){
            const json = JSON.stringify(value);
            assert.strictEqual(escapeAstral(json), json);
        }
    });

    it('gate off: an emoji value is the raw JSON text, as today', async function () {
        const isEnabled = gateStub(false);
        const texts = await stateValueTexts(() => ({ isEnabled }), 100, [{ key: 'k', value: EMOJI }, { key: 'n', value: 1 }]);
        assert.deepStrictEqual(texts, [JSON.stringify(EMOJI), '1']);
        assert.strictEqual(texts[0], '"' + EMOJI + '"');
        assert.strictEqual(gateCalls(isEnabled).length, 1);
        assert.strictEqual(gateCalls(isEnabled)[0].args[1], 100);
    });

    it('gate on: every astral value is escaped and parses back to the same value', async function () {
        const isEnabled = gateStub(true);
        const changes = [{ key: 'a', value: EMOJI }, { key: 'b', value: { x: EMOJI } }, { key: 'c', value: 'plain' }];
        const texts = await stateValueTexts(() => ({ isEnabled }), 7, changes);
        assert.deepStrictEqual(texts, ['"' + ESCAPED_EMOJI + '"', '{"x":"' + ESCAPED_EMOJI + '"}', '"plain"']);
        texts.forEach((t, i) => assert.deepStrictEqual(JSON.parse(t), changes[i].value));
        assert.strictEqual(gateCalls(isEnabled).length, 1, 'one gate read per writer call, never one per row');
    });

    it('never reads the gate, or the registry handle, when no value holds an astral character', async function () {
        const getter = sinon.stub().throws(new Error('the gate must not be read'));
        const texts = await stateValueTexts(getter, 7, [{ key: 'a', value: 'x' }, { key: 'b', value: '\uD83D' }]);
        assert.deepStrictEqual(texts, ['"x"', '"\\ud83d"']);
        assert.deepStrictEqual(await stateValueTexts(getter, 7, []), []);
        assert.strictEqual(getter.callCount, 0);
    });
});

// The VM result a writer receives: one emoji value plus one plain one.
const vmResult = () => ({
    success: true, error: null, gasUsed: 50, returnValue: null, logs: [],
    stateChanges: [{ key: 'face', value: EMOJI }, { key: 'n', value: 3 }],
    stateDeletes: [], emittedActions: [],
});

function storedValues(createContractState){
    return createContractState.getCalls().map((c) => c.args[0].STATE_VALUE);
}

async function runExecute(active){
    const { indexer, actionsCtx } = buildExecute();
    actionsCtx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: gateStub(active) };
    actionsCtx.vm = makeVm({ execute: sinon.stub().resolves(vmResult()) });
    const data = executeData({ FORMAT: 0 });
    await new Execute(actionsCtx).parse(['0', String(CONTRACT), 'run', ''], data, null);
    assert.strictEqual(data['STATUS'], 'valid');
    return storedValues(indexer.indexerDb.createContractState);
}

async function runDeploy(active){
    const { indexer, actionsCtx } = freshDeploySuite();
    actionsCtx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: gateStub(active) };
    actionsCtx.vm = makeDeployVm({ execute: sinon.stub().resolves(vmResult()) });
    const data = deployData({ FORMAT: 0 });
    await new Deploy(actionsCtx).parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);
    assert.strictEqual(data['STATUS'], 'valid');
    return storedValues(indexer.indexerDb.createContractState);
}

// The controller-guard path, on the stubbed DB the guard suites use.
async function runGuard(active){
    const indexer = createMockIndexer();
    const db = indexer.indexerDb;
    db.getContract               = sinon.stub().resolves({ code: "module.exports={meta:{name:'Guard',description:'Controller guard fixture.',version:'1.0.0'},guard:function(){}};", status_id: 7 });
    db.getContractPermissions    = sinon.stub().resolves(null);
    db.getStatusString           = sinon.stub().resolves('valid');
    db.getContractState          = sinon.stub().resolves({});
    db.getOracleDataForVM        = sinon.stub().resolves({});
    db.getCrossChainDataForVM    = sinon.stub().resolves({});
    db.getPollResultsForVM       = sinon.stub().resolves({ polls: {} });
    db.getContractStakeDataForVM = sinon.stub().resolves({});
    db.buildVmBalancesAndTokenInfo = sinon.stub().resolves({ balances: {}, tokenInfo: {} });
    db.createSavepoint           = sinon.stub().resolves('sp');
    db.releaseSavepoint          = sinon.stub().resolves();
    db.rollbackToSavepoint       = sinon.stub().resolves();
    db.createContractState       = sinon.stub().resolves();
    db.createContractEmission    = sinon.stub().resolves();
    db.createContractExecution   = sinon.stub().resolves();
    db.doQuery                   = sinon.stub().resolves([{ cnt: 0 }]);
    db.countContractEmissionsForExecution =
        require('../../../../src/db/contracts').countContractEmissionsForExecution.bind(db);
    indexer.vm    = { execute: sinon.stub().resolves(vmResult()) };
    indexer.hubDb = null;
    indexer.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: gateStub(active) };
    const res = await new Execute(indexer).runControllerGuard({
        actionType: 'ORDER_CREATE', controllerIndex: 5, tick: 'TOK',
        from: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH', to: '', amount: '100', price: '100', proceedsTick: 'PAY',
        hostData: { ACTION_INDEX: 10, BLOCK_INDEX: 100, BLOCK_TIME: 1700000000,
                    SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH', TX_HASH: 'aa', TX_INDEX: 1, TX_VOUT: 0 },
        callDepth: 0, seq: 0,
    });
    assert.strictEqual(res.allow, true);
    return storedValues(db.createContractState);
}

const WRITERS = { 'EXECUTE (run_vm)': runExecute, 'DEPLOY constructor': runDeploy, 'controller guard': runGuard };

describe('STATE_VALUE_ASTRAL_ESCAPE at each contract_state writer @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    for(const [name, run] of Object.entries(WRITERS)){
        it(name + ' stores the raw emoji JSON below the gate', async function () {
            assert.deepStrictEqual(await run(false), ['"' + EMOJI + '"', '3']);
        });

        it(name + ' stores the escaped emoji at the gate, and it parses back to the value', async function () {
            const stored = await run(true);
            assert.deepStrictEqual(stored, ['"' + ESCAPED_EMOJI + '"', '3']);
            assert.strictEqual(JSON.parse(stored[0]), EMOJI);
        });
    }
});
