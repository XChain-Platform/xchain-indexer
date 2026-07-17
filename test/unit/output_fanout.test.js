/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/output_fanout.test.js
 *
 * Unit tests for the reader-side per-output fan-out collapse
 * (src/output_fanout.js). Verifies that a data-bearing action whose
 * transaction fans out to multiple transaction_outputs rows executes
 * exactly once (one collapsed row) when FIX_OUTPUT_FANOUT is active,
 * that COINPAY/empty-data settlement rows keep their per-output fan-out,
 * and that the pre-activation guard aborts a multi-row data-bearing tx
 * instead of double-executing.
 */

'use strict';

const assert = require('assert');
const { collapseOutputFanout, isPerOutputSettlementRow } = require('../../src/output_fanout.js');

// Build a decoder row as getDecoderBlockData would emit it (one per output).
function row(tx_hash, data, vout, destination){
    return {
        data,
        tx_hash,
        source:      'source_addr',
        destination: destination || ('dest_' + vout),
        vout,
        amount:      1000,
        // Full output set for the tx (identical across that tx's rows in the real reader).
        tx_outputs:  [ { vout: 0, address: 'dispenser_addr', value: 500 },
                       { vout: 1, address: 'fee_dest_addr',  value: 500 } ]
    };
}

describe('output_fanout.collapseOutputFanout() @regression @tier1', function(){

    it('collapses a data-bearing SEND that paid a dispenser + fee output to ONE row (fix active)', function(){
        // SEND tx with two native outputs (dispenser payment + fee destination) => 2 rows.
        const input = [ row('sendtx', 'SEND|0|TOKEN|100', 0), row('sendtx', 'SEND|0|TOKEN|100', 1) ];
        const out   = collapseOutputFanout(input, true);
        assert.strictEqual(out.length, 1, 'SEND must execute once, not once per output row');
        assert.strictEqual(out[0].tx_hash, 'sendtx');
        // Deterministic winner: the lowest-vout row.
        assert.strictEqual(out[0].vout, 0);
        // The collapsed row still carries the full output set for fee validation.
        assert.strictEqual(out[0].tx_outputs.length, 2);
    });

    it('chooses the lowest-vout row regardless of input order (determinism)', function(){
        const input = [ row('sendtx', 'SEND|0|TOKEN|100', 3), row('sendtx', 'SEND|0|TOKEN|100', 1) ];
        const out   = collapseOutputFanout(input, true);
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].vout, 1);
    });

    it('keeps COINPAY multi-output fan-out unchanged (fix active)', function(){
        const input = [ row('cptx', 'COINPAY|0|abc', 0), row('cptx', 'COINPAY|0|abc', 1) ];
        const out   = collapseOutputFanout(input, true);
        assert.strictEqual(out.length, 2, 'COINPAY payment settlement fans out per output by design');
    });

    it('keeps empty-data DISPENSE per-output rows unchanged (fix active)', function(){
        // Empty data => DISPENSE settlement trigger; each output is its own settlement.
        const input = [ row('disptx', '', 0), row('disptx', '', 1) ];
        const out   = collapseOutputFanout(input, true);
        assert.strictEqual(out.length, 2, 'empty-data DISPENSE triggers process per output');
    });

    it('leaves a single-row data-bearing tx untouched (fix active)', function(){
        const input = [ row('onetx', 'SEND|0|TOKEN|100', 0) ];
        const out   = collapseOutputFanout(input, true);
        assert.deepStrictEqual(out, input);
    });

    it('preserves block ordering and only collapses the offending tx (fix active)', function(){
        const input = [
            row('a', 'ISSUE|0|X', 0),                 // single row, data-bearing
            row('b', 'SEND|0|TOKEN|100', 0),          // multi-row data-bearing -> collapse
            row('b', 'SEND|0|TOKEN|100', 1),
            row('c', 'COINPAY|0|abc', 0),             // COINPAY -> keep both
            row('c', 'COINPAY|0|abc', 1)
        ];
        const out = collapseOutputFanout(input, true);
        assert.deepStrictEqual(out.map(r => r.tx_hash), ['a', 'b', 'c', 'c']);
    });

    it('aborts (throws) on a multi-row data-bearing tx BELOW activation instead of double-executing', function(){
        const input = [ row('sendtx', 'SEND|0|TOKEN|100', 0), row('sendtx', 'SEND|0|TOKEN|100', 1) ];
        let logged = null;
        assert.throws(
            () => collapseOutputFanout(input, false, (m) => { logged = m; }),
            /CONSENSUS-CRITICAL/,
            'pre-activation multi-output data-bearing tx must halt the block'
        );
        assert.ok(logged && /CONSENSUS-CRITICAL/.test(logged), 'the fault must be logged before the throw');
    });

    it('does NOT abort below activation for COINPAY or empty-data multi-row txs', function(){
        const coinpay  = [ row('cptx', 'COINPAY|0|abc', 0), row('cptx', 'COINPAY|0|abc', 1) ];
        const dispense = [ row('disptx', '', 0), row('disptx', '', 1) ];
        assert.strictEqual(collapseOutputFanout(coinpay,  false).length, 2);
        assert.strictEqual(collapseOutputFanout(dispense, false).length, 2);
    });

    it('does NOT abort below activation for single-row data-bearing txs', function(){
        const input = [ row('a', 'SEND|0|TOKEN|100', 0), row('b', 'ISSUE|0|X', 0) ];
        const out   = collapseOutputFanout(input, false);
        assert.strictEqual(out.length, 2);
    });

    it('returns short inputs unchanged for either activation state', function(){
        assert.deepStrictEqual(collapseOutputFanout([], true), []);
        assert.deepStrictEqual(collapseOutputFanout([], false), []);
        const one = [ row('a', 'SEND|0|TOKEN|100', 0) ];
        assert.deepStrictEqual(collapseOutputFanout(one, false), one);
    });
});

describe('output_fanout.isPerOutputSettlementRow() @regression @tier1', function(){
    it('classifies empty / null / whitespace data as a settlement (DISPENSE) row', function(){
        assert.strictEqual(isPerOutputSettlementRow({ data: '' }), true);
        assert.strictEqual(isPerOutputSettlementRow({ data: null }), true);
        assert.strictEqual(isPerOutputSettlementRow({ data: '   ' }), true);
        assert.strictEqual(isPerOutputSettlementRow({}), true);
    });
    it('classifies COINPAY (any case / whitespace) as a settlement row', function(){
        assert.strictEqual(isPerOutputSettlementRow({ data: 'COINPAY|0|abc' }), true);
        assert.strictEqual(isPerOutputSettlementRow({ data: '  coinpay|0|abc  ' }), true);
    });
    it('classifies other action data as NOT a settlement row', function(){
        assert.strictEqual(isPerOutputSettlementRow({ data: 'SEND|0|TOKEN|100' }), false);
        assert.strictEqual(isPerOutputSettlementRow({ data: 'ISSUE|0|X' }), false);
        assert.strictEqual(isPerOutputSettlementRow({ data: 'DISPENSER|0|...' }), false);
    });
});
