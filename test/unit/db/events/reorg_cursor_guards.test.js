'use strict';

const assert = require('assert');

const {
    assertCursorWitness,
    assertCursorNotAboveNewest
} = require('../../../../src/db/events/reorg_cursor_guards.js');

function makeDb(rows) {
    const calls = [];
    const hashInputs = [];
    return {
        calls,
        hashInputs,
        async doQueryStrict(sql, params) {
            calls.push({ sql, params });
            return rows;
        },
        reorgCursorIncoherentError(msg) {
            return new Error(msg);
        },
        hashReorgData(data) {
            assert.strictEqual(data, 'd');
            hashInputs.push(data);
            return 'H';
        }
    };
}

async function rejectsWith(promise, fragment) {
    await assert.rejects(promise, (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes(fragment), err.message);
        return true;
    });
}

describe('assertCursorWitness', function () {
    it('throws when no live REORG row exists and queries with the cursor id', async function () {
        const db = makeDb([]);
        await rejectsWith(assertCursorWitness(db, 7, null),
            'decoder_event_id=7 points at no live decoder REORG event');
        assert.deepStrictEqual(db.calls[0].params, [7]);
    });

    it('resolves for a null witness, a matching witness and a string time', async function () {
        const db = makeDb([{ time: 5, data: 'd' }]);
        await assertCursorWitness(db, 7, null);
        await assertCursorWitness(db, 7, { time: 5, hash: 'H' });
        await assertCursorWitness(db, 7, { time: '5', hash: 'H' });
        assert.deepStrictEqual(db.hashInputs, ['d', 'd']);
    });

    it('throws on a time mismatch or a hash mismatch', async function () {
        const db = makeDb([{ time: 5, data: 'd' }]);
        await rejectsWith(assertCursorWitness(db, 7, { time: 6, hash: 'H' }), 'witness mismatch');
        await rejectsWith(assertCursorWitness(db, 7, { time: 5, hash: 'X' }), 'witness mismatch');
    });

    it('skips the comparison when the witness hash is null', async function () {
        const db = makeDb([{ time: 5, data: 'd' }]);
        await assertCursorWitness(db, 7, { time: 6, hash: null });
    });
});

describe('assertCursorNotAboveNewest', function () {
    it('reports null for a null max id and for an empty row list', async function () {
        const marker = "exceeds the decoder's newest REORG event id (null)";
        await rejectsWith(assertCursorNotAboveNewest(makeDb([{ max_id: null }]), 10), marker);
        await rejectsWith(assertCursorNotAboveNewest(makeDb([]), 10), marker);
    });

    it('throws when the newest id is below the cursor', async function () {
        await rejectsWith(assertCursorNotAboveNewest(makeDb([{ max_id: 9 }]), 10), '(9)');
    });

    it('resolves when the newest id equals or exceeds the cursor', async function () {
        await assertCursorNotAboveNewest(makeDb([{ max_id: 10 }]), 10);
        await assertCursorNotAboveNewest(makeDb([{ max_id: 11 }]), 10);
    });
});
