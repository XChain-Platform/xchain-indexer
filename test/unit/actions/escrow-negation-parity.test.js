// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Order_Expire = require('../../../src/actions/order_expire.js');
const Swap_Expire  = require('../../../src/actions/swap_expire.js');

// Escrow-release negation parity (#3736, stability-deepdive H-1)
//
// Every release handler pushes an escrow row for the same tick/address it
// credits. Negating the release with JS unary minus (`-amount`) coerces the
// full-precision VARCHAR amount to an IEEE-754 double, truncating digits past
// ~15 sig figs, while the paired credit keeps the intact string: the pair no
// longer nets to zero and the per-block supply sanity check trips. The fix
// negates in BigNumber space (bcsub(0, amount, 64)) at every release site.
describe('Escrow release negation parity @regression @tier1', function () {
    // 18-decimal remaining whose tail an IEEE-754 round-trip provably drops.
    const HI = '1000000.123456789012345678';

    function makeCtx(indexer) {
        return {
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
    }

    let indexer, ledgerSpy;

    beforeEach(function () {
        indexer   = createMockIndexer();
        ledgerSpy = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();
        indexer.util.resetLists();
    });
    afterEach(function () { sinon.restore(); });

    function assertParity(tick) {
        sinon.assert.calledOnce(ledgerSpy);
        const credits = ledgerSpy.firstCall.args[2];
        const escrows = ledgerSpy.firstCall.args[4];
        const esc     = escrows.find(e => e[0] === tick);
        const credit  = credits.find(c => c[0] === tick);
        assert.ok(esc,    tick + ' must have an escrow release row');
        assert.ok(credit, tick + ' must have a paired credit row');
        // Full 18-dp magnitude on both rows, no float truncation.
        assert.strictEqual(String(esc[1]),    '-' + HI, tick + ' escrow release lost precision');
        assert.strictEqual(String(credit[1]), HI,       tick + ' credit drifted');
        // The pair nets to exactly zero in BigNumber space.
        assert.strictEqual(String(indexer.util.bcadd(esc[1], credit[1], 64)), '0',
            tick + ' escrow release does not cancel the paired credit');
    }

    it('ORDER_EXPIRE releases an 18-dp remaining bit-exactly', async function () {
        indexer.indexerDb.getOrderInfo.resolves({
            ACTION_INDEX: 50,
            SOURCE:       'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            GIVE_TICK:    'HIDEC',
            GIVE_REMAINING: HI,
            GET_TICK:     'OTHER',
        });
        indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);
        const handler = new Order_Expire(makeCtx(indexer));
        await handler.parse(null, createBaseData({ ACTION: 'ORDER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 }), null);
        assertParity('HIDEC');
    });

    it('SWAP_EXPIRE releases an 18-dp amount bit-exactly', async function () {
        indexer.indexerDb.getSwapInfo.resolves({
            ACTION_INDEX: 60,
            SOURCE:       'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            GIVE_TICK:    'HIDEC',
            GIVE_AMOUNT:  HI,
            GET_TICK:     'OTHER',
        });
        const handler = new Swap_Expire(makeCtx(indexer));
        await handler.parse(null, createBaseData({ ACTION: 'SWAP_EXPIRE', ACTION_INDEX: 60, BLOCK_INDEX: 200 }), null);
        assertParity('HIDEC');
    });

    it('negative control: JS unary minus on the same value DOES lose precision', function () {
        assert.notStrictEqual(String(-HI), '-' + HI,
            'sanity: unary minus must corrupt this value, else the parity tests are vacuous');
        assert.strictEqual(String(indexer.util.bcsub(0, HI, 64)), '-' + HI);
    });

    it('no action handler negates a ledger amount with JS unary minus (source scan)', function () {
        // Pins the WHOLE release family (order/swap/coinpay/dispenser expire+cancel,
        // sweep, cross_settle, ...): a reintroduced `escrows.push([tick, -amount, addr])`
        // in any handler fails here without needing a per-handler behavioral repro.
        const actionsDir = path.join(__dirname, '../../../src/actions');
        const offenders  = [];
        for (const file of fs.readdirSync(actionsDir).filter(f => f.endsWith('.js'))) {
            const lines = fs.readFileSync(path.join(actionsDir, file), 'utf8').split('\n');
            lines.forEach((line, i) => {
                const code = line.split('//')[0];
                // A `, -identifier` inside a push/array literal is the unary-minus
                // negation shape; bc*-wrapped negation never matches (bcsub(0, x, 64)).
                if (/,\s*-[A-Za-z_$]/.test(code) && !/bc(sub|add|mul|div|round)\s*\(/.test(code))
                    offenders.push(`${file}:${i + 1}: ${line.trim()}`);
            });
        }
        assert.deepStrictEqual(offenders, [],
            'JS unary-minus ledger negation reintroduced (#3736):\n' + offenders.join('\n'));
    });
});
