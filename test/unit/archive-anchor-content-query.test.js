'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/archive-anchor-content-query.test.js
 *
 * The CONTENT-ADDRESSED archive-anchor lookup behind the getarchiveanchor
 * federation read.
 *
 * It exists because the hub's archive publish path broadcasts the v1/v6 head and
 * its v2 chunks BEFORE it records the batch, so a crash in that window re-elects
 * the same match rows and re-spends DOGE on a duplicate archive. Nothing already
 * in this repo could answer "is this batch already on-chain": every archive read
 * is keyed on match_batch_seq, and the file's own comment says that column is not
 * unique, while the restart allocates a fresh one anyway.
 *
 * The regression-worthy logic is the request validation (the content terms are
 * REQUIRED, not optional narrowing), the author-scoped head pick, the chunk
 * completeness math, and the response mapping. The DB read itself is exercised on
 * regtest / integration, as for the sibling getanchoraction helpers.
 ********************************************************************/

const assert = require('assert');
const {
    ARCHIVE_ANCHOR_BY_CONTENT_SQL, ARCHIVE_ANCHOR_ROW_LIMIT, ARCHIVE_CRC_RE,
    ARCHIVE_HEAD_VERSIONS, validateArchiveAnchorParams, selectArchiveHeadRow,
    presentChunkIndexes, buildArchiveAnchorResponse
} = require('../../src/anchor-action-query');

const CONFIG = { COIN: 'DOGE', NETWORK: 'regtest' };
const CRC    = 'deadbeef';

function head(over) {
    return Object.assign({
        action_index: 10, version: 1, chain: 'BTC', network: 'regtest', block_index: 500,
        checkpoint_seq: 100, snapshot_block: 90, match_batch_seq: 9, match_count: 4,
        batch_crc32: CRC, total_chunks: 3, block_index_doge: 700, status: 'valid',
        source: 'Dpub1', txid: 'AA'.repeat(32)
    }, over || {});
}

function ok(params) {
    return validateArchiveAnchorParams(Object.assign({
        chain: 'BTC', network: 'regtest', block_index: 500, checkpoint_seq: 100,
        batch_crc32: CRC, match_count: 4
    }, params || {}));
}

describe('archive-anchor content query: validateArchiveAnchorParams() @regression @tier1', function () {

    it('accepts a complete content key', function () {
        const v = ok();
        assert.strictEqual(v.ok, true);
        assert.strictEqual(v.block_index, 500);
        assert.strictEqual(v.checkpoint_seq, 100);
        assert.strictEqual(v.batch_crc32, CRC);
        assert.strictEqual(v.match_count, 4);
        assert.strictEqual(v.author, null);
    });

    // Without the content terms the question degenerates into "is this checkpoint
    // archived at all", which is true for a DIFFERENT batch under the same
    // checkpoint - and a publisher told that would drop its own unpublished matches.
    it('REQUIRES batch_crc32: it is part of the question, not a refinement of it', function () {
        assert.strictEqual(ok({ batch_crc32: undefined }).ok, false);
        assert.strictEqual(ok({ batch_crc32: null }).ok, false);
        assert.strictEqual(ok({ batch_crc32: '' }).ok, false);
    });

    it('REQUIRES match_count', function () {
        assert.strictEqual(ok({ match_count: undefined }).ok, false);
        assert.strictEqual(ok({ match_count: 'four' }).ok, false);
        assert.strictEqual(ok({ match_count: -1 }).ok, false);
    });

    it('rejects a malformed crc and normalizes case (anchor.js stores it lowercase)', function () {
        assert.strictEqual(ok({ batch_crc32: 'zzzzzzzz' }).ok, false);
        assert.strictEqual(ok({ batch_crc32: 'dead' }).ok, false);
        assert.strictEqual(ok({ batch_crc32: 'DEADBEEF' }).batch_crc32, CRC);
        assert.ok(ARCHIVE_CRC_RE.test('00000000'));
    });

    it('rejects a missing / non-integer checkpoint identity', function () {
        assert.strictEqual(ok({ chain: '' }).ok, false);
        assert.strictEqual(ok({ network: null }).ok, false);
        assert.strictEqual(ok({ block_index: -1 }).ok, false);
        assert.strictEqual(ok({ checkpoint_seq: 1.5 }).ok, false);
    });

    it('carries an optional author through, and rejects a non-string one', function () {
        assert.strictEqual(ok({ author: 'Dpub1' }).author, 'Dpub1');
        assert.strictEqual(ok({ author: '' }).author, null);
        assert.strictEqual(ok({ author: 42 }).ok, false);
    });
});

describe('archive-anchor content query: ARCHIVE_ANCHOR_BY_CONTENT_SQL @regression @tier1', function () {

    it('keys on the checkpoint identity AND the content commitment', function () {
        for (const term of ['a.chain = ?', 'a.network = ?', 'a.block_index = ?',
                            'a.checkpoint_seq = ?', 'a.batch_crc32 = ?', 'a.match_count = ?'])
            assert.ok(ARCHIVE_ANCHOR_BY_CONTENT_SQL.includes(term), 'missing predicate: ' + term);
    });

    // The whole point: the seq is what a restart loses, so it must not be in the key.
    it('does NOT filter on match_batch_seq', function () {
        assert.ok(!/WHERE[\s\S]*match_batch_seq\s*=/.test(ARCHIVE_ANCHOR_BY_CONTENT_SQL),
            'a seq predicate would reintroduce exactly the identity the restart cannot preserve');
    });

    it('selects the seq the batch landed under, so a resuming publisher can address its chunk slots', function () {
        assert.ok(/a\.match_batch_seq/.test(ARCHIVE_ANCHOR_BY_CONTENT_SQL));
    });

    it('restricts to ARCHIVE HEAD versions only (a v2 chunk carries no checkpoint identity)', function () {
        assert.deepStrictEqual(ARCHIVE_HEAD_VERSIONS, [1, 6]);
        assert.ok(/a\.version IN \(1, 6\)/.test(ARCHIVE_ANCHOR_BY_CONTENT_SQL));
        assert.ok(!/a\.version\s*=\s*1\b/.test(ARCHIVE_ANCHOR_BY_CONTENT_SQL),
            'a hand-copied version literal drifts the moment a new head version lands');
    });

    it('is bounded and picks the EARLIEST head, the same canonical rule the other head picks use', function () {
        assert.ok(ARCHIVE_ANCHOR_BY_CONTENT_SQL.includes('ORDER BY a.action_index ASC'));
        assert.ok(ARCHIVE_ANCHOR_BY_CONTENT_SQL.includes('LIMIT ' + ARCHIVE_ANCHOR_ROW_LIMIT));
    });

    // A row whose author or transaction linkage is missing must still come back, because
    // a vanished row reads to the hub as "definitively absent" and licenses a second spend.
    it('LEFT JOINs the author and txid linkage', function () {
        assert.ok(/LEFT JOIN\s+actions/.test(ARCHIVE_ANCHOR_BY_CONTENT_SQL));
        assert.ok(/LEFT JOIN\s+index_addresses/.test(ARCHIVE_ANCHOR_BY_CONTENT_SQL));
        assert.ok(/LEFT JOIN\s+transactions/.test(ARCHIVE_ANCHOR_BY_CONTENT_SQL));
        assert.ok(/LEFT JOIN\s+index_transactions/.test(ARCHIVE_ANCHOR_BY_CONTENT_SQL));
    });

    it('does not filter on status (mirrored and unmirrored nodes store the same head differently)', function () {
        assert.ok(!/s\.status\s*(=|NOT LIKE|IN)/.test(ARCHIVE_ANCHOR_BY_CONTENT_SQL));
        assert.ok(ARCHIVE_ANCHOR_BY_CONTENT_SQL.includes('s.status'), 'status is still RETURNED for the caller');
    });
});

describe('archive-anchor content query: selectArchiveHeadRow() @regression @tier1', function () {

    it('with no author, the EARLIEST row wins (rows arrive action_index ASC)', function () {
        const rows = [head({ action_index: 10 }), head({ action_index: 20 })];
        assert.strictEqual(selectArchiveHeadRow(rows, {}).action_index, 10);
    });

    // Unscoped, anyone who copied our mined head onto the chain answers "already
    // published" for a batch whose CHUNKS they never sent, and the real publisher then
    // skips its own head and strands the archive.
    it('an author filter narrows to that publishers own head', function () {
        const rows = [head({ action_index: 10, source: 'Dsquatter' }),
                      head({ action_index: 20, source: 'Dpub1' })];
        assert.strictEqual(selectArchiveHeadRow(rows, { author: 'Dpub1' }).action_index, 20);
    });

    it('a head with an unresolvable author is skipped (fail closed)', function () {
        const rows = [head({ source: null })];
        assert.strictEqual(selectArchiveHeadRow(rows, { author: 'Dpub1' }), null);
    });

    it('address comparison is exact, never case-folded', function () {
        const rows = [head({ source: 'DPUB1' })];
        assert.strictEqual(selectArchiveHeadRow(rows, { author: 'Dpub1' }), null);
    });

    it('returns null on an empty / absent row set', function () {
        assert.strictEqual(selectArchiveHeadRow([], {}), null);
        assert.strictEqual(selectArchiveHeadRow(null, {}), null);
    });
});

describe('archive-anchor content query: chunk presence @regression @tier1', function () {

    it('chunk 0 rides in the head, so it is present whenever the head is', function () {
        assert.deepStrictEqual(presentChunkIndexes(head(), []), [0]);
    });

    it('reports the continuation indexes on-chain, sorted and deduped', function () {
        const chunks = [{ chunk_index: 2 }, { chunk_index: 1 }, { chunk_index: 2 }];
        assert.deepStrictEqual(presentChunkIndexes(head(), chunks), [0, 1, 2]);
    });

    it('a complete batch reports chunks_complete', function () {
        const res = buildArchiveAnchorResponse(CONFIG, 705, head(), [{ chunk_index: 1 }, { chunk_index: 2 }]);
        assert.deepStrictEqual(res.chunks_present, [0, 1, 2]);
        assert.strictEqual(res.chunks_complete, true);
    });

    it('a partial batch does NOT report complete', function () {
        const res = buildArchiveAnchorResponse(CONFIG, 705, head(), [{ chunk_index: 1 }]);
        assert.deepStrictEqual(res.chunks_present, [0, 1]);
        assert.strictEqual(res.chunks_complete, false);
    });

    it('a gap in the middle is not complete even when the count adds up', function () {
        const res = buildArchiveAnchorResponse(CONFIG, 705, head({ total_chunks: 3 }),
            [{ chunk_index: 3 }, { chunk_index: 4 }]);
        assert.strictEqual(res.chunks_complete, false);
    });

    it('a malformed total_chunks can never be complete', function () {
        assert.strictEqual(buildArchiveAnchorResponse(CONFIG, 705, head({ total_chunks: null }), []).chunks_complete, false);
        assert.strictEqual(buildArchiveAnchorResponse(CONFIG, 705, head({ total_chunks: 0 }), []).chunks_complete, false);
    });
});

describe('archive-anchor content query: buildArchiveAnchorResponse() @regression @tier1', function () {

    it('maps an absent head to a definitive negative', function () {
        const res = buildArchiveAnchorResponse(CONFIG, 705, null, []);
        assert.strictEqual(res.exists, false);
        assert.strictEqual(res.confirmations, 0);
        assert.deepStrictEqual(res.chunks_present, []);
        assert.strictEqual(res.chunks_complete, false);
        assert.strictEqual(res.coin, 'DOGE');
    });

    it('returns the landed seq, the content key, the status and a lowercase txid', function () {
        const res = buildArchiveAnchorResponse(CONFIG, 705, head(), []);
        assert.strictEqual(res.exists, true);
        assert.strictEqual(res.match_batch_seq, 9);
        assert.strictEqual(res.match_count, 4);
        assert.strictEqual(res.batch_crc32, CRC);
        assert.strictEqual(res.status, 'valid');
        assert.strictEqual(res.version, 1);
        assert.strictEqual(res.author, 'Dpub1');
        assert.strictEqual(res.txid, 'aa'.repeat(32));
        assert.strictEqual(res.checkpoint_seq, 100);
    });

    it('computes DOGE-relative depth exactly as the checkpoint read does', function () {
        assert.strictEqual(buildArchiveAnchorResponse(CONFIG, 705, head(), []).confirmations, 6);
        // A row deeper than tip (rolled back) or a non-finite tip reports 0 rather than
        // a negative depth a caller might read as confirmed.
        assert.strictEqual(buildArchiveAnchorResponse(CONFIG, 699, head(), []).confirmations, 0);
        assert.strictEqual(buildArchiveAnchorResponse(CONFIG, null, head(), []).confirmations, 0);
    });

    it('a v6 (publisher-bearing) head answers the same question as a v1', function () {
        assert.strictEqual(buildArchiveAnchorResponse(CONFIG, 705, head({ version: 6 }), []).version, 6);
    });

    it('a missing txid linkage surfaces as null rather than removing the row', function () {
        const res = buildArchiveAnchorResponse(CONFIG, 705, head({ txid: null, source: null }), []);
        assert.strictEqual(res.exists, true);
        assert.strictEqual(res.txid, null);
        assert.strictEqual(res.author, null);
    });
});
