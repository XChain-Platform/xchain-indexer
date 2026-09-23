// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// THE ATTEST v5/v6 BATCH WIRE, second part: integrity (CRC and canonical base64), the
// consensus caps and head structure. The suite's header, and why each of these is
// consensus, is in test/unit/actions/attest/attest_batch_wire.test.js.

const assert = require('assert');
const crypto = require('crypto');
const zlib = require('zlib');

const abw = require('../../../../../src/actions/attest/attest_batch_wire.js');
const { ADMISSION_ERA, window_, noisy, toParams, roundTrip } = require('../../../../helpers/attest_batch_wire_fixture.js');

describe('ATTEST v5/v6 batch wire @regression @tier2', function () {
    describe('integrity: CRC and canonical base64', function () {
        it('reds a reassembled body whose CRC does not match the head', function () {
            const { enc, head, chunks } = roundTrip(window_(5));
            const tampered = { ...head, batchCrc32: 'deadbeef' };
            const out = abw.reassembleAttestBatch(tampered, chunks, ADMISSION_ERA);
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, abw.ATTEST_BATCH_FAIL_REASONS.CRC_MISMATCH);
            assert.strictEqual(out.status, 'invalid: ATTEST_BATCH (crc32-mismatch)');
            assert.strictEqual(abw.reassembleAttestBatch(head, chunks, ADMISSION_ERA).ok, true,
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
                const out = abw.reassembleAttestBatch(head, flip, ADMISSION_ERA);
                assert.strictEqual(out.ok, false, 'chunk ' + (i + 1) + ' corrupted must not reassemble clean');
                assert.ok(refusals.includes(out.reason), 'refused at the integrity layer, reason ' + out.reason);
            }
            const headFlip = abw.reassembleAttestBatch({ ...head, chunkB64: bump(head.chunkB64, 10) }, chunks, ADMISSION_ERA);
            assert.strictEqual(headFlip.ok, false, 'the head slice is body too');
            assert.ok(refusals.includes(headFlip.reason), 'reason ' + headFlip.reason);
            assert.strictEqual(abw.reassembleAttestBatch(head, chunks, ADMISSION_ERA).ok, true,
                'and the untouched batch still reassembles, which is what proves the fixture discriminates');
        });
    });
});

describe('ATTEST v5/v6 batch wire @regression @tier2', function () {
    describe('integrity: CRC and canonical base64', function () {
        it('refuses a non-canonical base64 spelling of the same bytes', function () {
            const { head, chunks } = roundTrip(window_(5));
            // The URL-safe alphabet is a DIFFERENT encoding; accepting both would give one
            // payload two wire spellings and fork the node whose runtime is less forgiving.
            const urlSafe = { ...head, chunkB64: head.chunkB64.replace(/\+/g, '-').replace(/\//g, '_') };
            if (urlSafe.chunkB64 !== head.chunkB64) {
                const out = abw.reassembleAttestBatch(urlSafe, chunks, ADMISSION_ERA);
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
});

describe('ATTEST v5/v6 batch wire @regression @tier2', function () {
    describe('the consensus caps', function () {
        it('holds the two frozen numbers', function () {
            assert.strictEqual(abw.ATTEST_BATCH_MAX_INFLATED_BYTES, 1048576);
            assert.strictEqual(abw.ATTEST_BATCH_MAX_ROWS, 256);
            assert.strictEqual(abw.ATTEST_BATCH_WIRE_MAX_BYTES, 8189);
            assert.strictEqual(abw.ATTEST_BATCH_MAX_CHUNKS, 256);
        });

        it('refuses a TOTAL_CHUNKS that cannot fit the column it is written to @regression', function () {
            // batch_total_chunks / batch_chunk_index are INT UNSIGNED (max 4294967295), and
            // actions/attest/index.js stamps the parsed count straight through, so an unbounded
            // count is a halt on any node running the MariaDB default sql_mode rather than
            // a refused wire.
            const win = window_(1);
            const p   = toParams(abw.encodeAttestBatch(win, ADMISSION_ERA).wires[0]);
            p[8] = '4294967296';
            assert.strictEqual(abw.parseAttestBatchHead(p).reason,
                abw.ATTEST_BATCH_FAIL_REASONS.TOTAL_CHUNKS);

            const key = abw.computeBatchKey(win);
            assert.strictEqual(
                abw.parseAttestBatchContinuation(['6', key, '4294967296', '4294967297', 'deadbeef', 'QUJD']).reason,
                abw.ATTEST_BATCH_FAIL_REASONS.TOTAL_CHUNKS,
                'and the continuation bounds CHUNK_INDEX transitively, through the same ceiling');
        });

        it('bounds TOTAL_CHUNKS at the ceiling on both wires, and accepts the ceiling itself', function () {
            const win = window_(1);
            const key = abw.computeBatchKey(win);
            const p   = toParams(abw.encodeAttestBatch(win, ADMISSION_ERA).wires[0]);

            p[8] = String(abw.ATTEST_BATCH_MAX_CHUNKS + 1);
            assert.strictEqual(abw.parseAttestBatchHead(p).reason,
                abw.ATTEST_BATCH_FAIL_REASONS.TOTAL_CHUNKS);
            p[8] = String(abw.ATTEST_BATCH_MAX_CHUNKS);
            assert.strictEqual(abw.parseAttestBatchHead(p).ok, true, 'the ceiling itself is legal');

            assert.strictEqual(
                abw.parseAttestBatchContinuation(['6', key, '1', String(abw.ATTEST_BATCH_MAX_CHUNKS + 1),
                                                  'deadbeef', 'QUJD']).reason,
                abw.ATTEST_BATCH_FAIL_REASONS.TOTAL_CHUNKS);
            assert.strictEqual(
                abw.parseAttestBatchContinuation(['6', key, '1', String(abw.ATTEST_BATCH_MAX_CHUNKS),
                                                  'deadbeef', 'QUJD']).ok,
                true, 'and so is a continuation inside it');
        });
    });
});

describe('ATTEST v5/v6 batch wire @regression @tier2', function () {
    describe('the consensus caps', function () {
        it('cannot refuse a batch this codebase can build: the encoder tops out under the ceiling', function () {
            // The bound is only safe if it sits above what encodeAttestBatch will EMIT, so
            // measure that rather than assert the comment. The worst case is the inflated
            // cap of incompressible bytes: deflate-raw barely shrinks it and base64 grows it
            // by a third, and one continuation carries ATTEST_BATCH_WIRE_MAX_BYTES minus its
            // prefix. If either constant moves so the encoder can outrun the parser, this
            // goes red instead of a real batch silently failing coverage in production.
            const b64  = zlib.deflateRawSync(crypto.randomBytes(abw.ATTEST_BATCH_MAX_INFLATED_BYTES),
                { level: zlib.constants.Z_BEST_COMPRESSION }).toString('base64');
            const contPrefix = 'ATTEST|6|' + 'a'.repeat(64) + '|999|999|deadbeef|';
            const ceiling = Math.ceil(b64.length / (abw.ATTEST_BATCH_WIRE_MAX_BYTES - contPrefix.length)) + 1;
            assert.ok(ceiling <= abw.ATTEST_BATCH_MAX_CHUNKS,
                'the encoder can need ' + ceiling + ' chunks, above the ' +
                abw.ATTEST_BATCH_MAX_CHUNKS + '-chunk parser ceiling');
        });

        it('refuses to encode more than 256 rows', function () {
            const out = abw.encodeAttestBatch(window_(257), ADMISSION_ERA);
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, abw.ATTEST_BATCH_FAIL_REASONS.ROW_COUNT);
            assert.strictEqual(abw.encodeAttestBatch(window_(256), ADMISSION_ERA).ok, true, '256 exactly is legal');
        });

        it('refuses a head declaring more than 256 rows, BEFORE anything consumes the count', function () {
            const win = window_(1);
            const p = toParams(abw.encodeAttestBatch(win, ADMISSION_ERA).wires[0]);
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
            const out = abw.reassembleAttestBatch(head, [], ADMISSION_ERA);
            assert.strictEqual(out.ok, false);
            assert.ok([abw.ATTEST_BATCH_FAIL_REASONS.SIZE_CAP,
                       abw.ATTEST_BATCH_FAIL_REASONS.RATIO_CAP].includes(out.reason),
                'refused at the bound rather than absorbed and rejected after, reason ' + out.reason);
        });
    });
});

describe('ATTEST v5/v6 batch wire @regression @tier2', function () {
    describe('the consensus caps', function () {
        it('reds a body whose row_count disagrees with the rows it carries', function () {
            // The header keys the gates and the body carries the rows; letting them
            // differ would let a publisher choose which one a node reads.
            const win = window_(3);
            const body = JSON.parse(abw.buildAttestBatchBody(win, ADMISSION_ERA));
            body.rows.pop();
            const raw  = Buffer.from(JSON.stringify(body), 'utf8');
            const head = {
                ok: true, batchKey: abw.computeBatchKey(win), network: win.network,
                windowStart: win.window_start, windowEnd: win.window_end,
                rowCount: 3, btcBlockHeight: win.btc_block_height,
                batchCrc32: abw.crc32Hex(raw), totalChunks: 1,
                chunkB64: zlib.deflateRawSync(raw).toString('base64'),
            };
            const out = abw.reassembleAttestBatch(head, [], ADMISSION_ERA);
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, abw.ATTEST_BATCH_FAIL_REASONS.ROW_COUNT);
        });

        it('reds a row missing a carried field', function () {
            const win  = window_(2);
            const body = JSON.parse(abw.buildAttestBatchBody(win, ADMISSION_ERA));
            delete body.rows[1].response_hash;
            const raw  = Buffer.from(JSON.stringify(body), 'utf8');
            const head = {
                ok: true, batchKey: abw.computeBatchKey(win), network: win.network,
                windowStart: win.window_start, windowEnd: win.window_end,
                rowCount: 2, btcBlockHeight: win.btc_block_height,
                batchCrc32: abw.crc32Hex(raw), totalChunks: 1,
                chunkB64: zlib.deflateRawSync(raw).toString('base64'),
            };
            const out = abw.reassembleAttestBatch(head, [], ADMISSION_ERA);
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, abw.ATTEST_BATCH_FAIL_REASONS.ROW_FIELD);
        });
    });
});

describe('ATTEST v5/v6 batch wire @regression @tier2', function () {
    describe('head structure', function () {

        it('refuses a head whose batch key does not derive from the window it declares', function () {
            const p = toParams(abw.encodeAttestBatch(window_(1), ADMISSION_ERA).wires[0]);
            p[4] = String(Number(p[4]) + 1);
            const out = abw.parseAttestBatchHead(p);
            assert.strictEqual(out.ok, false);
            assert.strictEqual(out.reason, abw.ATTEST_BATCH_FAIL_REASONS.BATCH_KEY,
                'a head under another window\'s key would reassemble under the wrong identity');
        });

        it('refuses non-canonical integer spellings and an inverted window', function () {
            const win = window_(1);
            for (const [idx, bad] of [[3, '01700000000'], [4, '-1'], [5, '1.5'], [6, '0x10']]) {
                const p = toParams(abw.encodeAttestBatch(win, ADMISSION_ERA).wires[0]);
                p[idx] = bad;
                assert.strictEqual(abw.parseAttestBatchHead(p).ok, false, 'field ' + idx + ' = ' + bad);
            }
            const inverted = toParams(abw.encodeAttestBatch(win, ADMISSION_ERA).wires[0]);
            inverted[3] = String(Number(inverted[4]) + 1);
            assert.strictEqual(abw.parseAttestBatchHead(inverted).ok, false);
        });

        it('refuses a head with a zero TOTAL_CHUNKS or an empty body field', function () {
            const win = window_(1);
            const zero = toParams(abw.encodeAttestBatch(win, ADMISSION_ERA).wires[0]);
            zero[8] = '0';
            assert.strictEqual(abw.parseAttestBatchHead(zero).reason, abw.ATTEST_BATCH_FAIL_REASONS.TOTAL_CHUNKS);
            const empty = toParams(abw.encodeAttestBatch(win, ADMISSION_ERA).wires[0]);
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
