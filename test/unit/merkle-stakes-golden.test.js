/*********************************************************************
 * test/unit/merkle-stakes-golden.test.js
 *
 * #4751: the stakes-root value leaves (stakeMemberLeaf / stakeTotalLeaf /
 * sumCanonicalAmounts, 94818db) and the lifted blockMerkleLeaves cross-kind
 * ordering are consensus-root inputs but shipped without a golden vector. A
 * future refactor of the BigInt scaling, leaf framing, or leaf ordering could
 * silently change the stakes-root / block_merkle_root with no test catching it.
 *
 * These vectors pin the current consensus output. If any of them changes, treat
 * it like a consensus change: the merkle module is byte-twinned with
 * xchain-sync, so a deliberate change must update both and re-baseline.
 *********************************************************************/

'use strict';

const assert = require('assert');
const m = require('../../src/merkle.js');

describe('merkle stakes-root + block-leaf golden vectors (#4751) @regression @tier1', function () {

    describe('stakes-root value leaves', function () {
        it('stakeMemberLeaf(source, weight) is pinned', function () {
            assert.strictEqual(
                m.stakeMemberLeaf('1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev', '5').toString('hex'),
                '9929bd48a07d56d18e7f94b75f5207c120cdbe8c10e94936b9dddac362488c1f');
        });

        it('stakeTotalLeaf(total) is pinned', function () {
            assert.strictEqual(
                m.stakeTotalLeaf('123.5').toString('hex'),
                '27bc4ed31278580c9a785dc88013394111bba9718d647ccc8f5fbd233c51621f');
        });
    });

    describe('sumCanonicalAmounts (exact 18-dp BigInt scaling)', function () {
        it('sums mixed-scale amounts exactly', function () {
            assert.strictEqual(
                m.sumCanonicalAmounts(['1.5', '2.25', '0.000000000000000001']),
                '3.750000000000000001');
        });
        it('empty input is canonical zero', function () {
            assert.strictEqual(m.sumCanonicalAmounts([]), '0.000000000000000000');
        });
        it('carries across the 18-dp boundary', function () {
            assert.strictEqual(
                m.sumCanonicalAmounts(['0.999999999999999999', '0.000000000000000001']),
                '1.000000000000000000');
        });
    });

    describe('blockMerkleLeaves cross-kind ordering (consensus-critical, leaf index defines proof position)', function () {
        it('emits ledger (credit, debit, escrow) -> actions -> contract sub-tables in the frozen order', function () {
            const rows = {
                ledger: {
                    credits:  [{ action_index: 1, address: 'addrC', tick: 'TKC', amount: '1' }],
                    debits:   [{ action_index: 2, address: 'addrD', tick: 'TKD', amount: '2' }],
                    escrows:  [{ action_index: 3, address: 'addrE', tick: 'TKE', amount: '3' }],
                },
                actions: [{ action_index: 4, tx_index: 0, action: 'SEND' }],
                contracts: {
                    contracts: [{ action_index: 5, source_address: 'src', code_hash: 'ch', status: 'valid' }],
                },
            };
            const expected = [
                m.ledgerLeaf({ kind: 'credit', action_index: 1, address: 'addrC', tick: 'TKC', amount: '1' }),
                m.ledgerLeaf({ kind: 'debit',  action_index: 2, address: 'addrD', tick: 'TKD', amount: '2' }),
                m.ledgerLeaf({ kind: 'escrow', action_index: 3, address: 'addrE', tick: 'TKE', amount: '3' }),
                m.actionsLeaf({ action_index: 4, tx_index: 0, action: 'SEND' }),
                m.contractLeaf('contracts', [5, 'src', 'ch', 'valid']),
            ];
            const got = m.blockMerkleLeaves(rows);
            assert.strictEqual(got.length, expected.length, 'leaf count');
            for (let i = 0; i < expected.length; i++) {
                assert.ok(Buffer.compare(got[i], expected[i]) === 0,
                    'leaf ' + i + ' out of frozen cross-kind order');
            }
        });
    });
});
