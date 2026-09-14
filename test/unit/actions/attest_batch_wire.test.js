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
// THE ATTEST v5/v6 BATCH WIRE (src/actions/attest/attest_batch_wire.js).
//
// The module is pure, so everything it owes can be asserted directly rather than
// inferred from a handler's side effects: a window in, wires out, and the same
// window back. What is under test here is the part a batch cannot recover from
// getting wrong - the caps, the canonical base64 rule, the CRC, and coverage -
// because each of those is consensus on every indexing node and a batch that one
// node reads and the next refuses is a fork, not a bug.
//
// xchain-hub carries a byte-identical twin of the module. These cases are
// therefore written against the exported API alone, with no reach into module
// internals, so the twin can run them unchanged.
//
// The suite is split by behaviour: round trip, chunking and coverage here, integrity,
// the consensus caps and head structure in test/unit/actions/attest_batch_wire.test/batch_wire_integrity.test.js,
// both under the same suite title, with the fixtures in test/helpers/attest_batch_wire_fixture.js.

const assert = require('assert');
const crypto = require('crypto');

const abw = require('../../../src/actions/attest/attest_batch_wire.js');
const { PUBKEY_A, SIG_A, window_, noisy, roundTrip } = require('../../helpers/attest_batch_wire_fixture.js');

describe('ATTEST v5/v6 batch wire @regression @tier2', function () {
    describe('round trip', function () {
        it('carries a window out and back with every row field intact', function () {
            const win = window_(5);
            const { enc, head, chunks } = roundTrip(win);
            assert.strictEqual(enc.totalChunks, 1, 'a small window rides one wire');

            const out = abw.reassembleAttestBatch(head, chunks);
            assert.strictEqual(out.ok, true, out.reason);
            assert.strictEqual(out.batch.row_count, 5);
            assert.strictEqual(out.batch.rows.length, 5);
            assert.deepStrictEqual(Object.keys(out.batch.rows[0]), abw.ATTEST_BATCH_ROW_FIELDS,
                'the carried field set and its ORDER are the wire contract');
            assert.deepStrictEqual(out.batch.rows[2], win.rows[2],
                'a row survives compression and reassembly byte for byte');
            assert.deepStrictEqual(out.batch.sigs, [{ pubkey: PUBKEY_A, sig: SIG_A }]);
        });

        it('carries the columns the mirror table has and NONE of the three it must not', function () {
            // id is a hub-local cursor, finalized_at is hub wall clock, and
            // batch_action_index is set BY the batch landing, so a batch that carried
            // its own would be describing an action that does not exist yet.
            for (const banned of ['id', 'finalized_at', 'batch_action_index'])
                assert.strictEqual(abw.ATTEST_BATCH_ROW_FIELDS.includes(banned), false,
                    banned + ' must never ride the batch wire');
            assert.ok(abw.ATTEST_BATCH_ROW_FIELDS.includes('signatures'),
                'the per-row responsible-set signatures ride the chain, which is what makes a ' +
                'batch-fed node\'s attests rows identical to a mirror-fed node\'s');
        });

        it('an EMPTY window is a legal batch: a row_count 0 head, still signed', function () {
            // Coverage has to be provable for a chain-only node, so every window
            // publishes even when nothing finalized in it.
            const { enc, head, chunks } = roundTrip(window_(0));
            assert.strictEqual(enc.totalChunks, 1);
            assert.strictEqual(head.rowCount, 0);
            const out = abw.reassembleAttestBatch(head, chunks);
            assert.strictEqual(out.ok, true, out.reason);
            assert.deepStrictEqual(out.batch.rows, []);
        });

        it('the batch key derives from the window and nothing else', function () {
            const key = abw.computeBatchKey({ network: 'regtest', window_start: 1700000000, window_end: 1700003600 });
            assert.match(key, /^[0-9a-f]{64}$/);
            assert.strictEqual(key,
                crypto.createHash('sha256').update('ATTESTBATCH:regtest:1700000000:1700003600').digest('hex'),
                'the preimage is consensus: every node and the hub twin must derive the same key');
            assert.notStrictEqual(key,
                abw.computeBatchKey({ network: 'testnet', window_start: 1700000000, window_end: 1700003600 }),
                'two networks never share a batch key');
        });
    });
});

describe('ATTEST v5/v6 batch wire @regression @tier2', function () {
    describe('round trip', function () {
        it('the signed canonical covers the window and its rows, and NOT the signatures', function () {
            // The BATCH quorum's own signature (distinct from the per-row responsible-set
            // signatures, which DO ride inside the rows and therefore inside the preimage).
            const QUORUM_SIG = '7'.repeat(128);
            const win = window_(3, undefined, { sigs: [{ pubkey: PUBKEY_A, sig: QUORUM_SIG }] });
            const canonical = abw.buildAttestBatchCanonical(win);
            assert.strictEqual(canonical.includes(QUORUM_SIG), false,
                'signatures cannot sign themselves, so they are outside the preimage');
            assert.ok(canonical.includes(SIG_A),
                'the per-row responsible-set signatures ARE signed: they are row content');
            assert.strictEqual(
                abw.buildAttestBatchCanonical({ ...win, sigs: [] }), canonical,
                'a different signature set over one window is the SAME signed bytes');
            assert.notStrictEqual(
                abw.buildAttestBatchCanonical({ ...win, btc_block_height: 900001 }), canonical,
                'the anchor the quorum is resolved at is inside the preimage');
        });
    });
});

describe('ATTEST v5/v6 batch wire @regression @tier2', function () {
    describe('chunking at the wire boundary', function () {

        it('splits an incompressible window across chunks, none of them over 8189 bytes', function () {
            const { enc } = roundTrip(window_(40, noisy));
            assert.ok(enc.totalChunks > 1, 'the fixture must actually chunk, or it tests nothing');
            for (const w of enc.wires)
                assert.ok(Buffer.byteLength(w, 'utf8') <= abw.ATTEST_BATCH_WIRE_MAX_BYTES,
                    'a wire over the ceiling could not be broadcast at all');
            // The budget covers the WHOLE action string, prefix included, so a split that
            // measured only the payload would produce wires the encoder refuses.
            assert.ok(enc.wires[0].startsWith('ATTEST|5|'));
            assert.ok(enc.wires[1].startsWith('ATTEST|6|'));
            assert.ok(Buffer.byteLength(enc.wires[0], 'utf8') > abw.ATTEST_BATCH_WIRE_MAX_BYTES - 200,
                'the head fills its wire rather than leaving the budget unspent');
        });

        it('reassembles a chunked window identically to a single-wire one', function () {
            const win = window_(40, noisy);
            const { head, chunks } = roundTrip(win);
            const out = abw.reassembleAttestBatch(head, chunks);
            assert.strictEqual(out.ok, true, out.reason);
            assert.deepStrictEqual(out.batch.rows, JSON.parse(abw.buildAttestBatchBody(win)).rows);
        });

        it('numbers continuations 1..TOTAL_CHUNKS-1, leaving slot 0 to the head', function () {
            const { enc, chunks } = roundTrip(window_(40, noisy));
            assert.deepStrictEqual(chunks.map(c => c.chunk_index),
                Array.from({ length: enc.totalChunks - 1 }, (_, i) => i + 1));
            // A continuation claiming the head's slot is refused rather than allowed to
            // displace it in the coverage set.
            const zero = abw.parseAttestBatchContinuation(
                ['6', abw.computeBatchKey(window_(0)), '0', '3', 'deadbeef', 'QUJD']);
            assert.strictEqual(zero.ok, false);
            assert.strictEqual(zero.reason, abw.ATTEST_BATCH_FAIL_REASONS.CHUNK_INDEX);
        });

        it('refuses a continuation whose index is at or past TOTAL_CHUNKS', function () {
            const key = abw.computeBatchKey(window_(0));
            for (const idx of ['3', '4', '99'])
                assert.strictEqual(
                    abw.parseAttestBatchContinuation(['6', key, idx, '3', 'deadbeef', 'QUJD']).reason,
                    abw.ATTEST_BATCH_FAIL_REASONS.CHUNK_INDEX);
        });
    });
});

describe('ATTEST v5/v6 batch wire @regression @tier2', function () {
    describe('coverage', function () {

        it('refuses reassembly while any slot is missing', function () {
            const { head, chunks } = roundTrip(window_(40, noisy));
            for (let drop = 0; drop < chunks.length; drop++) {
                const short = chunks.filter((_, i) => i !== drop);
                const out = abw.reassembleAttestBatch(head, short);
                assert.strictEqual(out.ok, false, 'slot ' + (drop + 1) + ' missing must refuse');
                assert.strictEqual(out.reason, abw.ATTEST_BATCH_FAIL_REASONS.COVERAGE);
            }
        });

        it('resolves a duplicated slot by the LOWEST action_index, whatever the read order', function () {
            const { head, chunks } = roundTrip(window_(40, noisy));
            const impostor = { chunk_index: 1, chunk_b64: 'QUJD', action_index: 999999 };
            const good = abw.reassembleAttestBatch(head, chunks);
            // A junk chunk broadcast LATER must not squat a slot the real one holds, in
            // either read order: two nodes reading the same rows differently ordered have
            // to reassemble the same bytes or they fork.
            const a = abw.reassembleAttestBatch(head, [impostor].concat(chunks));
            const b = abw.reassembleAttestBatch(head, chunks.concat([impostor]));
            assert.strictEqual(a.ok, true, a.reason);
            assert.deepStrictEqual(a.batch, good.batch);
            assert.deepStrictEqual(b.batch, good.batch);
        });

        it('ignores chunks outside the declared range rather than counting them', function () {
            const { head, chunks } = roundTrip(window_(40, noisy));
            const stray = { chunk_index: head.totalChunks + 5, chunk_b64: 'QUJD', action_index: 1 };
            const out = abw.reassembleAttestBatch(head, chunks.concat([stray]));
            assert.strictEqual(out.ok, true, out.reason);
        });

        it('attestChunkCoverage answers null on an incomplete set and orders a complete one', function () {
            const set = [{ chunk_index: 2, chunk_b64: 'B' }, { chunk_index: 1, chunk_b64: 'A' }];
            assert.deepStrictEqual(abw.attestChunkCoverage(set, 3).map(c => c.chunk_b64), ['A', 'B']);
            assert.strictEqual(abw.attestChunkCoverage(set, 4), null);
            assert.deepStrictEqual(abw.attestChunkCoverage([], 1), [], 'a single-wire batch needs no chunks');
        });
    });
});
