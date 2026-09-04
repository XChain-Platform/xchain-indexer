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
// THE ATTEST BATCH CHUNK READ AND ITS ROW LIMIT (row 59).
//
// A batch key is sha256 over the window it names, so anyone can derive it and file
// wires under it for one fee each. The read that answers "what is on chain for this
// batch" therefore has to be bounded, and the bound has to sit AFTER the publisher
// partition: taken before it, junk filling the low slots empties the window and the
// honest publisher's own head and chunks fall outside it. These cases pin both halves:
// the scoped read carries the author into the query and the limit after it, and the
// limit is above every chunk count the wire geometry can produce, so an honest chunk
// set is never truncated.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const Database = require('../../../src/db.js');
const abw      = require('../../../src/attest_batch_wire.js');

const AUTHOR  = 'nWbnkorpwGHrGQjaLo2rmyRQPPzn8CFrKQ';
const FOREIGN = 'nUxUJZAhGwNyZDvqSHUFZ2NhVKAqZbnyDp';

// A Database with nothing but doQuery, which is all this read touches. The stub honours
// the query's own LIMIT, so a case here fails when the constant moves rather than when
// the test's copy of it does.
function readerFor(rows) {
    const db = Object.create(Database.prototype);
    db.doQuery = sinon.stub().callsFake(async (query, params) => {
        const authored = query.includes('cadr.address = ?') ? String(params[1]) : null;
        let out = rows
            .filter(r => String(r.request_id) === String(params[0]))
            .filter(r => authored === null || String(r.source) === authored)
            .sort((a, b) => (Number(a.chunk_index) - Number(b.chunk_index)) ||
                            (Number(a.action_index) - Number(b.action_index)));
        const limit = query.match(/LIMIT (\d+)/);
        if (limit) out = out.slice(0, Number(limit[1]));
        return out;
    });
    return db;
}

// One publisher's real batch, encoded by the codec and stored the way a landing stores
// it. The payloads are random so they do not compress, which is what makes the batch
// span many wires without approaching the inflated-body cap.
function encodeBatch(rowCount, payloadBytes) {
    const rows = [];
    for (let i = 0; i < rowCount; i++) {
        rows.push({
            network: 'regtest', request_id: crypto.createHash('sha256').update('r' + i).digest('hex'),
            request_action_index: 100 + i, request_block_index: 900, provider_id: 'http_get',
            status: 'ok', response_payload: crypto.randomBytes(payloadBytes).toString('base64'),
            response_hash: crypto.createHash('sha256').update('h' + i).digest('hex'),
            meta: '', effective_time: 1700000000 + i,
            signer_pubkeys: '[]', signatures: '[]', widen: 0,
        });
    }
    const window = {
        network: 'regtest', window_start: 1700000000, window_end: 1700003600,
        row_count: rows.length, btc_block_height: 900000, rows, sigs: [],
    };
    const encoded = abw.encodeAttestBatch(window);
    assert.strictEqual(encoded.ok, true, 'fixture assumption: the window encodes');
    return encoded;
}

// The chunk rows the wires land as, in a deliberately scrambled action order so nothing
// but the query's ORDER BY can put them back together.
function storedRows(encoded, author, firstActionIndex) {
    const head = abw.parseAttestBatchHead(encoded.wires[0].split('|').slice(1));
    assert.strictEqual(head.ok, true, 'fixture assumption: the head wire parses');
    const rows = encoded.wires.map((wire, slot) => ({
        action_index:     firstActionIndex + (encoded.wires.length - slot),
        version:          slot === 0 ? abw.ATTEST_BATCH_HEAD_VERSION : abw.ATTEST_BATCH_CONTINUATION_VERSION,
        request_id:       encoded.batchKey,
        window_start:     1700000000,
        window_end:       1700003600,
        row_count:        head.rowCount,
        btc_block_height: 900000,
        batch_crc32:      encoded.batchCrc32,
        total_chunks:     encoded.totalChunks,
        chunk_index:      slot,
        chunk_b64:        wire.split('|').slice(-1)[0],
        source:           author,
    }));
    return { head, rows };
}

describe('ATTEST batch chunk read: the publisher partition and its row limit (row 59) @regression', function () {

    afterEach(function () { sinon.restore(); });

    it('carries no author term and no limit when nothing is scoped, the legacy shape', async function () {
        const db = readerFor([]);
        await db.getAttestBatchChunks('a'.repeat(64));
        const [query, params] = db.doQuery.firstCall.args;
        assert.strictEqual(query.includes('cadr.address = ?'), false);
        assert.strictEqual(/LIMIT/.test(query), false,
            'an unscoped read cannot carry a limit: taken before the partition it is a denial vector');
        assert.deepStrictEqual(params, ['a'.repeat(64)]);
    });

    it('puts the limit AFTER the author term, and binds the author rather than interpolating it', async function () {
        const db = readerFor([]);
        await db.getAttestBatchChunks('A'.repeat(64), AUTHOR);
        const [query, params] = db.doQuery.firstCall.args;
        assert.ok(query.includes('cadr.address = ?'), 'the partition moves into the query');
        assert.ok(/LIMIT \d+/.test(query), 'and the scoped read is bounded');
        assert.ok(query.indexOf('cadr.address = ?') < query.indexOf('LIMIT'),
            'the limit must apply to one publisher\'s rows, never to the whole key\'s');
        assert.strictEqual(query.includes(AUTHOR), false, 'the address is a bound parameter, never SQL text');
        assert.deepStrictEqual(params, ['a'.repeat(64), AUTHOR],
            'and the key is lowercased on the way in, as the stored column is');
    });

    it('is bounded above every chunk count the wire geometry can produce', async function () {
        // The worst honest batch: an inflated body at the cap that does not compress, so
        // deflate-raw expands it (5 bytes per 16383-byte stored block, plus 6) and base64
        // adds a third, spread over wires that each lose their prefix to the header.
        const inflated   = abw.ATTEST_BATCH_MAX_INFLATED_BYTES;
        const deflated   = inflated + 5 * Math.ceil(inflated / 16383) + 6;
        const encoded    = Math.ceil(deflated / 3) * 4;
        // 'ATTEST|6|' + 64-hex key + two counts + an 8-hex CRC and their separators, at a
        // digit width wider than any batch this size can reach.
        const PREFIX_MAX = 9 + 64 + 1 + 4 + 1 + 4 + 1 + 8 + 1;
        const worstChunks = Math.ceil(encoded / (abw.ATTEST_BATCH_WIRE_MAX_BYTES - PREFIX_MAX));

        const db = readerFor([]);
        await db.getAttestBatchChunks('b'.repeat(64), AUTHOR);
        const value = Number(db.doQuery.firstCall.args[0].match(/LIMIT (\d+)/)[1]);

        assert.ok(worstChunks > 1, 'sanity: the ceiling is a real chunk count, not a degenerate 1');
        assert.ok(value >= worstChunks,
            'the row limit (' + value + ') is below the ' + worstChunks + ' wires the largest ' +
            'legal batch needs, so an honest publisher\'s own chunk set would be truncated ' +
            'and its window denied');
    });

    it('reassembles a real multi-chunk batch read back through the bounded query', async function () {
        const encoded = encodeBatch(20, 6000);
        assert.ok(encoded.totalChunks > 2, 'fixture assumption: the batch spans several wires');
        const { head, rows } = storedRows(encoded, AUTHOR, 5000);

        const db = readerFor(rows);
        const read = await db.getAttestBatchChunks(encoded.batchKey, AUTHOR);
        assert.strictEqual(read.length, encoded.totalChunks,
            'the whole chunk set survives the bound; a limit that clipped it would deny the window');

        const assembled = abw.reassembleAttestBatch(head, read.filter(r => Number(r.chunk_index) !== 0));
        assert.strictEqual(assembled.ok, true,
            'a truncated read fails here on coverage, which is what the bound must never cause');
        assert.strictEqual(assembled.batch.rows.length, 20);
    });

    it('still hands a foreign publisher nothing of this batch', async function () {
        const encoded = encodeBatch(20, 6000);
        const { head, rows } = storedRows(encoded, AUTHOR, 5000);

        const db = readerFor(rows);
        assert.deepStrictEqual(await db.getAttestBatchChunks(encoded.batchKey, FOREIGN), [],
            'the partition is the query\'s, so another publisher reads its own batch and not this one');

        // And the honest set is what reassembles, not the union: the same rows read
        // unscoped still carry only this author's, so the bound changes no verdict.
        const unscoped = await db.getAttestBatchChunks(encoded.batchKey);
        assert.strictEqual(abw.reassembleAttestBatch(head,
            unscoped.filter(r => String(r.source) === AUTHOR && Number(r.chunk_index) !== 0)).ok, true);
    });
});
