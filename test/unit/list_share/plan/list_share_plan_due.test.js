'use strict';

const assert = require('assert');
const { planDueVersions } = require('../../../../src/consensus/list_share_settle/plan.js');

const L = (home_chain, home_list_index, applied, rows) => ({ home_chain, home_list_index, applied, rows });
const r = (seq, height) => ({ seq, admit_block_btc: height });
const plan = (lists, extra = {}) => planDueVersions({ lists, coin: 'BTC', blockIndex: 150, cap: 10, ...extra });

describe('planDueVersions', () => {
    it('waits on a row whose height is not yet reached', () => {
        const out = plan([L('DOGE', 7, 0, [r(1, 200)])]);
        assert.deepStrictEqual(out, { due: [] });
    });

    it('takes the due prefix and stops at the first future row', () => {
        const d1 = r(1, 100), d2 = r(2, 150);
        const out = plan([L('DOGE', 7, 0, [d1, d2, r(3, 151)])]);
        assert.strictEqual(out.due.length, 2);
        assert.strictEqual(out.due[0], d1);
        assert.strictEqual(out.due[1], d2);
    });

    it('halts on a gap behind a due later seq', () => {
        const out = plan([L('DOGE', 7, 0, [r(2, 100)])]);
        assert.deepStrictEqual(out, { halt: { reason: 'SEQ_GAP', home_chain: 'DOGE', home_list_index: 7, seq: 1 } });
    });

    it('halts on a missing height behind a due later seq', () => {
        const out = plan([L('DOGE', 7, 0, [r(1, null), r(2, 100)])]);
        assert.deepStrictEqual(out, { halt: { reason: 'NO_HEIGHT', home_chain: 'DOGE', home_list_index: 7, seq: 1 } });
    });

    it('treats an absent height column as no height', () => {
        const out = plan([L('DOGE', 7, 0, [{ seq: 1 }, r(2, 100)])]);
        assert.strictEqual(out.halt.reason, 'NO_HEIGHT');
    });

    it('does not halt on an absent next seq with nothing later due', () => {
        assert.deepStrictEqual(plan([L('DOGE', 7, 0, [r(2, 200)])]), { due: [] });
        assert.deepStrictEqual(plan([L('DOGE', 7, 0, [])]), { due: [] });
    });

    it('does not halt on a heightless next seq with nothing later due', () => {
        assert.deepStrictEqual(plan([L('DOGE', 7, 0, [r(1, null), r(2, 200)])]), { due: [] });
    });

    it('cuts at the cap keeping a contiguous prefix of each list', () => {
        const x1 = r(1, 1), x2 = r(2, 1), y1 = r(1, 1), y2 = r(2, 1);
        const out = plan([L('LTC', 2, 0, [y1, y2]), L('DOGE', 9, 0, [x1, x2])], { blockIndex: 10, cap: 3 });
        assert.strictEqual(out.due.length, 3);
        assert.strictEqual(out.due[0], x1);
        assert.strictEqual(out.due[1], x2);
        assert.strictEqual(out.due[2], y1);
    });

    it('returns the first halting list in (home_chain, home_list_index) order', () => {
        const out = plan([
            L('LTC', 1, 0, [r(2, 100)]),
            L('DOGE', 10, 0, [r(2, 100)]),
            L('DOGE', 9, 0, [r(1, null), r(2, 100)])
        ]);
        assert.deepStrictEqual(out.halt, { reason: 'NO_HEIGHT', home_chain: 'DOGE', home_list_index: 9, seq: 1 });
    });

    it('orders list indexes numerically', () => {
        const a = r(1, 1), b = r(1, 1);
        const out = plan([L('DOGE', 10, 0, [a]), L('DOGE', '9', 0, [b])]);
        assert.strictEqual(out.due[0], b);
        assert.strictEqual(out.due[1], a);
    });

    it('starts the walk after the applied count', () => {
        const s3 = r(3, 100);
        const out = plan([L('DOGE', 7, 2, [r(1, 100), r(2, 100), s3, r(4, 200)])]);
        assert.strictEqual(out.due.length, 1);
        assert.strictEqual(out.due[0], s3);
    });

    it('accepts decimal strings and BigInts', () => {
        const s2 = { seq: '2', admit_block_btc: '100' };
        const s3 = { seq: 3n, admit_block_btc: 120n };
        const out = plan([L('DOGE', 7n, '1', [s3, s2])]);
        assert.strictEqual(out.due.length, 2);
        assert.strictEqual(out.due[0], s2);
        assert.strictEqual(out.due[1], s3);
    });

    it('reads the height column for the coin', () => {
        const row = { seq: 1, admit_block_btc: 500, admit_block_doge: 5 };
        assert.strictEqual(plan([L('DOGE', 1, 0, [row])], { coin: 'DOGE' }).due[0], row);
        assert.deepStrictEqual(plan([L('DOGE', 1, 0, [row])], { coin: 'BTC' }), { due: [] });
    });

    it('throws a TypeError on invalid arguments', () => {
        assert.throws(() => plan('x'), TypeError);
        assert.throws(() => plan([], { coin: 'ETH' }), TypeError);
        assert.throws(() => plan([], { blockIndex: -1 }), TypeError);
        assert.throws(() => plan([], { blockIndex: 1.5 }), TypeError);
        assert.throws(() => plan([], { cap: 0 }), TypeError);
        assert.throws(() => plan([], { cap: 1.5 }), TypeError);
    });
});
