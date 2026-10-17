'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fc = require('fast-check');
const sinon = require('sinon');
const Decimal = require('decimal.js');

const { createBaseData, createMockIndexer, createTokenInfo } = require('../../../fixtures/mocks');
const Airdrop = require('../../../../src/actions/airdrop');
const Dividend = require('../../../../src/actions/dividend');

const SOURCE = 'payer';

function actionContext(indexer) {
    return {
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

function decimalFromAtoms(atoms, decimals) {
    const scale = 10n ** BigInt(decimals);
    const whole = atoms / scale;
    if(decimals === 0)
        return String(whole);
    const fraction = String(atoms % scale).padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? String(whole) + '.' + fraction : String(whole);
}

function atomsFromDecimal(value, decimals) {
    const parts = new Decimal(String(value)).toFixed(decimals).split('.');
    const whole = parts[0] || '0';
    const fraction = (parts[1] || '').padEnd(decimals, '0');
    return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction || '0');
}

function makeHolders(holderAtoms, includeSource) {
    const holders = {};
    holderAtoms.forEach((atoms, index) => {
        holders['holder' + String(index).padStart(3, '0')] = decimalFromAtoms(atoms, 18);
    });
    if(includeSource)
        holders[SOURCE] = '100';
    return holders;
}

describe('Distribution rounding and conservation @money @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('floors every dividend share once and debits exactly the emitted credits at decimals 0 through 18', async function () {
        const indexer = createMockIndexer();
        const handler = new Dividend(actionContext(indexer));

        await fc.assert(fc.asyncProperty(
            fc.array(fc.bigInt({ min: 1n, max: 10n ** 22n }), { minLength: 1, maxLength: 20 }),
            fc.bigInt({ min: 0n, max: 10n ** 12n }),
            fc.boolean(),
            async (holderAtoms, rateAtoms, includeSource) => {
                for(let decimals = 0; decimals <= 18; decimals++){
                    const holders = makeHolders(holderAtoms, includeSource);
                    const amount = decimalFromAtoms(rateAtoms, decimals);
                    const dividend = {};
                    const recipients = await handler.buildDividendRecipients(
                        { AMOUNT: amount, SOURCE, BLOCK_INDEX: 100 },
                        holders,
                        { DECIMALS: decimals, ALLOW_LIST: null, BLOCK_LIST: null },
                        dividend
                    );

                    let expectedDebitAtoms = 0n;
                    holderAtoms.forEach((atoms, index) => {
                        const address = 'holder' + String(index).padStart(3, '0');
                        const expectedAtoms = (atoms * rateAtoms) / (10n ** 18n);
                        if(expectedAtoms === 0n){
                            assert.strictEqual(Object.hasOwn(recipients, address), false);
                        } else {
                            assert.strictEqual(atomsFromDecimal(recipients[address], decimals), expectedAtoms);
                            expectedDebitAtoms += expectedAtoms;
                        }
                    });
                    assert.strictEqual(Object.hasOwn(recipients, SOURCE), false);
                    assert.strictEqual(atomsFromDecimal(dividend.DEBIT, decimals), expectedDebitAtoms);
                    const emittedAtoms = Object.values(recipients)
                        .reduce((sum, amountValue) => sum + atomsFromDecimal(amountValue, decimals), 0n);
                    assert.strictEqual(emittedAtoms, expectedDebitAtoms);
                }
            }
        ), { seed: 0x44525644, numRuns: 40 });
    });

    it('includes an exact one-unit dividend share and omits sub-unit dust', async function () {
        const indexer = createMockIndexer();
        const handler = new Dividend(actionContext(indexer));
        const dividend = {};
        const recipients = await handler.buildDividendRecipients(
            { AMOUNT: '0.00000001', SOURCE, BLOCK_INDEX: 100 },
            { exact: '1', dust: '0.000000000000000001', [SOURCE]: '50' },
            { DECIMALS: 8, ALLOW_LIST: null, BLOCK_LIST: null },
            dividend
        );

        assert.deepStrictEqual(Object.keys(recipients), ['exact']);
        assert.strictEqual(atomsFromDecimal(recipients.exact, 8), 1n);
        assert.strictEqual(atomsFromDecimal(dividend.DEBIT, 8), 1n);
    });

    it('airdrops debit exactly the sum of recipient legs at decimals 0 through 18', async function () {
        sinon.stub(console, 'log');
        const indexer = createMockIndexer();
        const handler = new Airdrop(actionContext(indexer));

        await fc.assert(fc.asyncProperty(
            fc.integer({ min: 1, max: 30 }),
            fc.bigInt({ min: 1n, max: 10n ** 12n }),
            async (recipientCount, amountAtoms) => {
                for(let decimals = 0; decimals <= 18; decimals++){
                    const amount = decimalFromAtoms(amountAtoms, decimals);
                    const recipients = new Set(Array.from(
                        { length: recipientCount },
                        (_, index) => 'recipient' + String(index).padStart(3, '0')
                    ));
                    const debit = handler.util.bcmul(recipientCount, amount, decimals);
                    const ctx = {
                        credits: [],
                        debits: [],
                        fees: { AMOUNT: 0 },
                        gasTick: 'GAS',
                    };
                    const airdrop = { TICK: 'DROP', AMOUNT: amount, DEBIT: debit, SOURCE };
                    await handler.settleAirdropLeg(airdrop, { SOURCE }, ctx, null, recipients, 0);

                    const creditAtoms = ctx.credits
                        .filter(row => row[0] === 'DROP')
                        .reduce((sum, row) => sum + atomsFromDecimal(row[1], decimals), 0n);
                    const debitAtoms = ctx.debits
                        .filter(row => row[0] === 'DROP' && row[2] === SOURCE)
                        .reduce((sum, row) => sum + atomsFromDecimal(row[1], decimals), 0n);
                    assert.strictEqual(creditAtoms, amountAtoms * BigInt(recipientCount));
                    assert.strictEqual(debitAtoms, creditAtoms);
                }
            }
        ), { seed: 0x41495244, numRuns: 40 });
    });

    it('same-token and distinct-token dividends produce the same conserved recipient shares', async function () {
        async function run(holdingTick, payoutTick) {
            const indexer = createMockIndexer();
            const handler = new Dividend(actionContext(indexer));
            const holdingInfo = createTokenInfo({ TICK: holdingTick, TICK_ID: 1, DECIMALS: 8 });
            const payoutInfo = holdingTick === payoutTick
                ? holdingInfo
                : createTokenInfo({ TICK: payoutTick, TICK_ID: 2, DECIMALS: 8 });
            indexer.indexerDb.getTokenInfo.callsFake(async tick => {
                if(tick === holdingTick) return holdingInfo;
                if(tick === payoutTick) return payoutInfo;
                return null;
            });
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [SOURCE]: '100', holderA: '2', holderB: '0.5' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            const ledger = sinon.spy(indexer.util, 'processTransactionLedgerChanges');
            const data = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });

            await handler.parse(['0', holdingTick, payoutTick, '0.25', null], data, null);

            assert.strictEqual(data.STATUS, 'valid');
            const credits = ledger.lastCall.args[2]
                .filter(row => row[0] === payoutTick)
                .map(row => [atomsFromDecimal(row[1], 8), row[2]]);
            const debits = ledger.lastCall.args[3]
                .filter(row => row[0] === payoutTick && row[2] === SOURCE)
                .map(row => atomsFromDecimal(row[1], 8));
            return { credits, debits };
        }

        const sameToken = await run('HELD', 'HELD');
        sinon.restore();
        const distinctToken = await run('HELD', 'BRIDGED');
        assert.deepStrictEqual(distinctToken, sameToken);
        assert.strictEqual(
            sameToken.debits.reduce((sum, amount) => sum + amount, 0n),
            sameToken.credits.reduce((sum, row) => sum + row[0], 0n)
        );
    });
});
