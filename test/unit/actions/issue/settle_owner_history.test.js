'use strict';

const assert = require('assert');
const sinon      = require('sinon');

const ledger = require('../../../../src/utility/ledger.js');
const settle = require('../../../../src/actions/issue/settle.js');

function buildHandler() {
    const util = Object.assign({}, ledger, {
        addresses: {},
        tickers:   [],
        isNull:    v => v === null || v === undefined || v === '',
        bcgt:      () => false,
        getTickersList:     function () { return this.tickers; },
        getAddressesList:   function () { return this.addresses; },
        processTransactionFees:          sinon.stub().callsFake(async (db, c, d) => [c, d]),
        processTransactionLedgerChanges: sinon.stub().resolves(),
    });
    const indexerDb = {
        createToken:    sinon.stub().resolves(),
        updateBalances: sinon.stub().resolves(),
        updateTokens:   sinon.stub().resolves(),
    };
    return { util, indexerDb, config: {}, protocolChanges: { isEnabled: sinon.stub().resolves(false) } };
}

function ctxFor(data) {
    return { data, fees: { AMOUNT: '0', TICK: 'XCHAIN' }, issue: {}, error: null };
}

describe('ISSUE settlement owner history', function () {
    it('lists the owner named at creation in the addresses refreshed for the tick', async function () {
        const h    = buildHandler();
        const data = { TICK: 'TEST', SOURCE: 'addrSource', TRANSFER: 'addrOwner', BLOCK_INDEX: 100 };
        await settle.settleValidIssue.call(h, ctxFor(data));
        assert.ok(Object.prototype.hasOwnProperty.call(h.util.addresses, 'addrOwner'));
        assert.ok(h.util.addresses['addrOwner'].includes('TEST'));
        assert.ok(h.indexerDb.updateBalances.firstCall.args[0].includes('addrOwner'));
    });

    it('adds no extra address when the source keeps ownership', async function () {
        const h    = buildHandler();
        const data = { TICK: 'TEST', SOURCE: 'addrSource', TRANSFER: '', BLOCK_INDEX: 100 };
        await settle.settleValidIssue.call(h, ctxFor(data));
        assert.deepStrictEqual(Object.keys(h.util.addresses), []);
    });
});
