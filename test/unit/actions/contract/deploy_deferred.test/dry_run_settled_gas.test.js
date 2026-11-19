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
// DEPLOY and its chunk carriers debit GAS without a fees row, so a dry run learns what they
// charged only from PROBE_SETTLED_GAS_FEE. It must equal the GAS this action's single ledger
// write debits its source, and decoded (non dry-run) transactions must never carry it.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { B64, HASH, assemblerRow, carrierChunk, buildHarness, assemblerData, carrierData } =
    require('./helpers/harness.js');

// Sum of the GAS debits the action's ledger write(s) charged its own source.
function chargedTo(h, source){
    let sum = '0';
    for(const w of h.ledgerWrites)
        for(const d of w.debits)
            if(d[2] === source) sum = h.indexer.util.bcadd(sum, d[1], 8);
    return String(sum);
}

describe('DEPLOY dry-run settled gas probe @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('an inline DEPLOY reports exactly the GAS its ledger write debits', async function () {
        const h = buildHarness({ chunkRows: [] });
        const data = carrierData({ FORMAT: 0, ACTION_INDEX: 950, DRY_RUN: true });
        await h.handler.parse(['0', B64, '100000', 'x'], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(h.ledgerWrites.length, 1);
        assert.notStrictEqual(chargedTo(h, data['SOURCE']), '0');
        assert.strictEqual(data['PROBE_SETTLED_GAS_FEE'], chargedTo(h, data['SOURCE']));
    });

    it('a decoded DEPLOY carries no probe field', async function () {
        const h = buildHarness({ chunkRows: [] });
        const data = carrierData({ FORMAT: 0, ACTION_INDEX: 950 });
        await h.handler.parse(['0', B64, '100000', 'x'], data, null);
        assert.strictEqual(h.ledgerWrites[0].debits.length, 1);
        assert.strictEqual(data['PROBE_SETTLED_GAS_FEE'], undefined);
    });

    it('a pending assembler reports the base fee it pays', async function () {
        const h = buildHarness({ chunkRows: [] });
        const data = assemblerData({ DRY_RUN: true });
        await h.handler.parse(['2', HASH, '100000', 'x'], data, null);
        assert.strictEqual(data['STATUS'], 'pending: CODE_HASH (awaiting chunks)');
        assert.strictEqual(data['PROBE_SETTLED_GAS_FEE'], chargedTo(h, data['SOURCE']));
        assert.strictEqual(data['PROBE_SETTLED_GAS_FEE'], '1');
    });

    it('a native-paid or refused DEPLOY reports no settled gas', async function () {
        const native = buildHarness({ chunkRows: [] });
        native.indexer.util.detectFeePaymentMode = () => 'native';
        native.indexer.util.validateNativeCoinFee = async () => ({ valid: true, nativeCoinAmount: '0.001', nativeCoin: 'BTC', oracleRound: 7 });
        const paidNatively = carrierData({ FORMAT: 0, ACTION_INDEX: 950, DRY_RUN: true });
        await native.handler.parse(['0', B64, '100000', 'x'], paidNatively, null);
        assert.strictEqual(paidNatively['STATUS'], 'valid');
        assert.strictEqual(paidNatively['PROBE_SETTLED_GAS_FEE'], undefined);

        const broke = buildHarness({ chunkRows: [], balance: '0' });
        const refused = carrierData({ FORMAT: 0, ACTION_INDEX: 951, DRY_RUN: true });
        await broke.handler.parse(['0', B64, '100000', 'x'], refused, null);
        assert.notStrictEqual(refused['STATUS'], 'valid');
        assert.strictEqual(refused['PROBE_SETTLED_GAS_FEE'], undefined);
    });
});

describe('DEPLOY chunk carrier dry-run settled gas probe @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('a stored carrier reports its own per-byte fee', async function () {
        const h = buildHarness({ chunkRows: [] });
        const data = carrierData({ DRY_RUN: true });
        await h.handler.parse(['4', HASH, '0', '1', B64], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(h.ledgerWrites.length, 1);
        assert.notStrictEqual(chargedTo(h, data['SOURCE']), '0');
        assert.strictEqual(data['PROBE_SETTLED_GAS_FEE'], chargedTo(h, data['SOURCE']));
    });

    it('a completing carrier reports its own fee plus the deployment fee it carries', async function () {
        const h = buildHarness({ chunkRows: [carrierChunk()], pendingAssembler: assemblerRow() });
        const data = carrierData({ DRY_RUN: true });
        await h.handler.parse(['4', HASH, '0', '1', B64], data, null);
        assert.strictEqual(h.ledgerWrites.length, 1);
        assert.strictEqual(h.ledgerWrites[0].debits.length, 2);
        const carrierFee = String(h.ledgerWrites[0].debits[0][1]);
        assert.notStrictEqual(data['PROBE_SETTLED_GAS_FEE'], carrierFee, 'not the carrier fee alone');
        assert.strictEqual(data['PROBE_SETTLED_GAS_FEE'], chargedTo(h, data['SOURCE']));
    });

    it('a decoded carrier carries no probe field', async function () {
        const h = buildHarness({ chunkRows: [carrierChunk()], pendingAssembler: assemblerRow() });
        const data = carrierData();
        await h.handler.parse(['4', HASH, '0', '1', B64], data, null);
        assert.strictEqual(h.ledgerWrites[0].debits.length, 2);
        assert.strictEqual(data['PROBE_SETTLED_GAS_FEE'], undefined);

        const stored = buildHarness({ chunkRows: [] });
        const slice = carrierData();
        await stored.handler.parse(['4', HASH, '0', '1', B64], slice, null);
        assert.strictEqual(stored.ledgerWrites[0].debits.length, 1);
        assert.strictEqual(slice['PROBE_SETTLED_GAS_FEE'], undefined);
    });
});
