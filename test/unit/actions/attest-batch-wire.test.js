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
// THE ATTEST v5/v6 BATCH WIRE (src/attest_batch_wire.js).
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

const assert = require('assert');
const crypto = require('crypto');
const zlib   = require('zlib');

const abw = require('../../../src/attest_batch_wire.js');

const PUBKEY_A = 'a'.repeat(64);
const SIG_A    = '1'.repeat(128);

// A row shaped exactly as the mirror table holds one. `filler` drives how
// compressible the window is: repetitive bodies fit one wire, random ones chunk.
function batchRow(i, filler) {
    return {
        network:              'regtest',
        request_id:           crypto.createHash('sha256').update('req' + i).digest('hex'),
        request_action_index: 100 + i,
        request_block_index:  90 + i,
        provider_id:          'http_get',
        status:               'ok',
        response_payload:     filler === undefined ? 'body-' + i : filler(i),
        response_hash:        crypto.createHash('sha256').update('body-' + i).digest('hex'),
        meta:                 'm',
        effective_time:       1700000000 + i,
        signer_pubkeys:       JSON.stringify([PUBKEY_A]),
        signatures:           JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG_A }]),
        widen:                0,
    };
}

function window_(rowCount, filler, overrides = {}) {
    const rows = [];
    for (let i = 0; i < rowCount; i++) rows.push(batchRow(i, filler));
    return {
        network:          'regtest',
        window_start:     1700000000,
        window_end:       1700003600,
        row_count:        rows.length,
        btc_block_height: 900000,
        rows:             rows,
        sigs:             [{ pubkey: PUBKEY_A, sig: SIG_A }],
        ...overrides,
    };
}

// Deterministic pseudo-random filler: incompressible enough to force chunking (a
// REPEATED block would deflate away and quietly leave every chunking case running
// against a single wire), and stable across runs so a failure is reproducible.
function noisy(i) {
    let out = '';
    for (let k = 0; k < 8; k++)
        out += crypto.createHash('sha512').update('noise:' + i + ':' + k).digest('base64');
    return out;
}

// A wire string as the decoder hands it to a handler: positional fields with
// params[0] the VERSION and the action name already stripped.
function toParams(wire) {
    return wire.split('|').slice(1);
}

function chunkRows(wires) {
    return wires.slice(1).map((w, i) => {
        const c = abw.parseAttestBatchContinuation(toParams(w));
        assert.strictEqual(c.ok, true, 'fixture continuation must parse');
        return { chunk_index: c.chunkIndex, chunk_b64: c.chunkB64, action_index: 500 + i };
    });
}

function roundTrip(win) {
    const enc = abw.encodeAttestBatch(win);
    assert.strictEqual(enc.ok, true, 'fixture window must encode');
    const head = abw.parseAttestBatchHead(toParams(enc.wires[0]));
    assert.strictEqual(head.ok, true, 'fixture head must parse');
    return { enc, head, chunks: chunkRows(enc.wires) };
}

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

    describe('integrity: CRC and canonical base64', function () {

        it('reds a reassembled body whose CRC does not match the head', function () {
            const { enc, head, chunks } = roundTrip(window_(5));
            const tampered = { ...head, batchCrc32: 'deadbeef' };
            const out = abw.reassembleAttestBatch(tampered, chunks);
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, abw.ATTEST_BATCH_FAIL_REASONS.CRC_MISMATCH);
            assert.strictEqual(out.status, 'invalid: ATTEST_BATCH (crc32-mismatch)');
            assert.strictEqual(abw.reassembleAttestBatch(head, chunks).ok, true,
                'and the untampered head still reassembles, so the fixture discriminates');
            assert.match(enc.batchCrc32, /^[0-9a-f]{8}$/);
        });

        it('reds a single corrupted byte in the reassembled body', function () {
            // The one falsification the batch exists to survive: a chunk that arrives
            // altered must never be absorbed as if it were the signed content.
            const { head, chunks } = roundTrip(window_(60, noisy));
            assert.ok(chunks.length >= 2, 'the fixture must carry real continuations');
            const refusals = [abw.ATTEST_BATCH_FAIL_REASONS.CRC_MISMATCH,
                              abw.ATTEST_BATCH_FAIL_REASONS.BASE64,
                              abw.ATTEST_BATCH_FAIL_REASONS.INFLATE,
                              abw.ATTEST_BATCH_FAIL_REASONS.NOT_UTF8,
                              abw.ATTEST_BATCH_FAIL_REASONS.BODY_JSON];
            const bump = (s, at) => s.slice(0, at) + (s[at] === 'A' ? 'B' : 'A') + s.slice(at + 1);

            // Every chunk in turn, the head's own slice included: a corrupted byte
            // anywhere in the body must be refused, never absorbed as signed content.
            for (let i = 0; i < chunks.length; i++) {
                const flip = chunks.map((c, j) => (j === i ? { ...c, chunk_b64: bump(c.chunk_b64, 10) } : c));
                assert.notStrictEqual(flip[i].chunk_b64, chunks[i].chunk_b64, 'the fixture must actually change a byte');
                const out = abw.reassembleAttestBatch(head, flip);
                assert.strictEqual(out.ok, false, 'chunk ' + (i + 1) + ' corrupted must not reassemble clean');
                assert.ok(refusals.includes(out.reason), 'refused at the integrity layer, reason ' + out.reason);
            }
            const headFlip = abw.reassembleAttestBatch({ ...head, chunkB64: bump(head.chunkB64, 10) }, chunks);
            assert.strictEqual(headFlip.ok, false, 'the head slice is body too');
            assert.ok(refusals.includes(headFlip.reason), 'reason ' + headFlip.reason);
            assert.strictEqual(abw.reassembleAttestBatch(head, chunks).ok, true,
                'and the untouched batch still reassembles, which is what proves the fixture discriminates');
        });

        it('refuses a non-canonical base64 spelling of the same bytes', function () {
            const { head, chunks } = roundTrip(window_(5));
            // The URL-safe alphabet is a DIFFERENT encoding; accepting both would give one
            // payload two wire spellings and fork the node whose runtime is less forgiving.
            const urlSafe = { ...head, chunkB64: head.chunkB64.replace(/\+/g, '-').replace(/\//g, '_') };
            if (urlSafe.chunkB64 !== head.chunkB64) {
                const out = abw.reassembleAttestBatch(urlSafe, chunks);
                assert.strictEqual(out.ok, false);
                assert.strictEqual(out.reason, abw.ATTEST_BATCH_FAIL_REASONS.BASE64);
            }
            // Whitespace, bad padding and a non-canonical final quantum are each rejected
            // by decodeCanonicalBase64 itself, which is what the reassembly leans on.
            assert.strictEqual(abw.decodeCanonicalBase64('QU JD'), null, 'embedded whitespace');
            assert.strictEqual(abw.decodeCanonicalBase64('QUJ'), null, 'unpadded');
            assert.strictEqual(abw.decodeCanonicalBase64('QR=='), null,
                'a final quantum whose unused bits are not zero is a second spelling of 0x41');
            assert.ok(Buffer.isBuffer(abw.decodeCanonicalBase64('QQ==')));
        });

        it('rejects a malformed CRC field on either leg', function () {
            const win = window_(1);
            const { enc } = roundTrip(win);
            const p = toParams(enc.wires[0]);
            p[7] = 'nothex!!';
            assert.strictEqual(abw.parseAttestBatchHead(p).reason, abw.ATTEST_BATCH_FAIL_REASONS.CRC_FORMAT);
            assert.strictEqual(
                abw.parseAttestBatchContinuation(['6', abw.computeBatchKey(win), '1', '2', 'zzz', 'QUJD']).reason,
                abw.ATTEST_BATCH_FAIL_REASONS.CRC_FORMAT);
        });
    });

    describe('the consensus caps', function () {

        it('holds the two frozen numbers', function () {
            assert.strictEqual(abw.ATTEST_BATCH_MAX_INFLATED_BYTES, 1048576);
            assert.strictEqual(abw.ATTEST_BATCH_MAX_ROWS, 256);
            assert.strictEqual(abw.ATTEST_BATCH_WIRE_MAX_BYTES, 8189);
        });

        it('refuses to encode more than 256 rows', function () {
            const out = abw.encodeAttestBatch(window_(257));
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, abw.ATTEST_BATCH_FAIL_REASONS.ROW_COUNT);
            assert.strictEqual(abw.encodeAttestBatch(window_(256)).ok, true, '256 exactly is legal');
        });

        it('refuses a head declaring more than 256 rows, BEFORE anything consumes the count', function () {
            const win = window_(1);
            const p = toParams(abw.encodeAttestBatch(win).wires[0]);
            p[5] = '100000';
            const out = abw.parseAttestBatchHead(p);
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, abw.ATTEST_BATCH_FAIL_REASONS.ROW_COUNT,
                'an attacker-supplied count drives a parse loop on every indexing node');
        });

        it('refuses a body that inflates past the 1 MiB budget', function () {
            // A bomb: one repeated byte deflates to nothing and inflates past the cap.
            const bomb = zlib.deflateRawSync(Buffer.alloc(abw.ATTEST_BATCH_MAX_INFLATED_BYTES + 4096, 0x41),
                { level: zlib.constants.Z_BEST_COMPRESSION }).toString('base64');
            const head = {
                ok: true, batchKey: 'a'.repeat(64), network: 'regtest',
                windowStart: 1, windowEnd: 2, rowCount: 0, btcBlockHeight: 1,
                batchCrc32: 'deadbeef', totalChunks: 1, chunkB64: bomb,
            };
            const out = abw.reassembleAttestBatch(head, []);
            assert.strictEqual(out.ok, false);
            assert.ok([abw.ATTEST_BATCH_FAIL_REASONS.SIZE_CAP,
                       abw.ATTEST_BATCH_FAIL_REASONS.RATIO_CAP].includes(out.reason),
                'refused at the bound rather than absorbed and rejected after, reason ' + out.reason);
        });

        it('reds a body whose row_count disagrees with the rows it carries', function () {
            // The header keys the gates and the body carries the rows; letting them
            // differ would let a publisher choose which one a node reads.
            const win = window_(3);
            const body = JSON.parse(abw.buildAttestBatchBody(win));
            body.rows.pop();
            const raw  = Buffer.from(JSON.stringify(body), 'utf8');
            const head = {
                ok: true, batchKey: abw.computeBatchKey(win), network: win.network,
                windowStart: win.window_start, windowEnd: win.window_end,
                rowCount: 3, btcBlockHeight: win.btc_block_height,
                batchCrc32: abw.crc32Hex(raw), totalChunks: 1,
                chunkB64: zlib.deflateRawSync(raw).toString('base64'),
            };
            const out = abw.reassembleAttestBatch(head, []);
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, abw.ATTEST_BATCH_FAIL_REASONS.ROW_COUNT);
        });

        it('reds a row missing a carried field', function () {
            const win  = window_(2);
            const body = JSON.parse(abw.buildAttestBatchBody(win));
            delete body.rows[1].response_hash;
            const raw  = Buffer.from(JSON.stringify(body), 'utf8');
            const head = {
                ok: true, batchKey: abw.computeBatchKey(win), network: win.network,
                windowStart: win.window_start, windowEnd: win.window_end,
                rowCount: 2, btcBlockHeight: win.btc_block_height,
                batchCrc32: abw.crc32Hex(raw), totalChunks: 1,
                chunkB64: zlib.deflateRawSync(raw).toString('base64'),
            };
            const out = abw.reassembleAttestBatch(head, []);
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, abw.ATTEST_BATCH_FAIL_REASONS.ROW_FIELD);
        });
    });

    describe('head structure', function () {

        it('refuses a head whose batch key does not derive from the window it declares', function () {
            const p = toParams(abw.encodeAttestBatch(window_(1)).wires[0]);
            p[4] = String(Number(p[4]) + 1);
            const out = abw.parseAttestBatchHead(p);
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, abw.ATTEST_BATCH_FAIL_REASONS.BATCH_KEY,
                'a head under another window\'s key would reassemble under the wrong identity');
        });

        it('refuses non-canonical integer spellings and an inverted window', function () {
            const win = window_(1);
            for (const [idx, bad] of [[3, '01700000000'], [4, '-1'], [5, '1.5'], [6, '0x10']]) {
                const p = toParams(abw.encodeAttestBatch(win).wires[0]);
                p[idx] = bad;
                assert.strictEqual(abw.parseAttestBatchHead(p).ok, false, 'field ' + idx + ' = ' + bad);
            }
            const inverted = toParams(abw.encodeAttestBatch(win).wires[0]);
            inverted[3] = String(Number(inverted[4]) + 1);
            assert.strictEqual(abw.parseAttestBatchHead(inverted).ok, false);
        });

        it('refuses a head with a zero TOTAL_CHUNKS or an empty body field', function () {
            const win = window_(1);
            const zero = toParams(abw.encodeAttestBatch(win).wires[0]);
            zero[8] = '0';
            assert.strictEqual(abw.parseAttestBatchHead(zero).reason, abw.ATTEST_BATCH_FAIL_REASONS.TOTAL_CHUNKS);
            const empty = toParams(abw.encodeAttestBatch(win).wires[0]);
            empty[9] = '';
            assert.strictEqual(abw.parseAttestBatchHead(empty).reason, abw.ATTEST_BATCH_FAIL_REASONS.BASE64);
        });

        it('every failure carries a stable status string and never throws', function () {
            for (const junk of [null, undefined, [], ['5'], ['5', 'nope'], ['5', 'a'.repeat(64)]]) {
                const out = abw.parseAttestBatchHead(junk);
                assert.strictEqual(out.ok, false);
                assert.match(out.status, /^invalid: ATTEST_BATCH \([a-z0-9-]+\)$/,
                    'the status reaches the chain, so its shape is history');
            }
        });
    });
});
