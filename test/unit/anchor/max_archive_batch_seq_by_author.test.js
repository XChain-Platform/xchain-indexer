'use strict';

const assert = require('assert');
const sinon = require('sinon');

const mirrorReads = require('../../../src/db/database/mirror_reads.js');
const { validateArchiveAnchorParams } = require('../../../src/actions/anchor/anchor_action_query');
const { buildAnchorRpc } = require('../../../src/api/rpc/anchor.js');

const AUTHOR = 'DPublisher';
const CONTENT_KEY = {
    chain: 'BTC', network: 'regtest', block_index: 500, checkpoint_seq: 12,
    batch_crc32: 'deadbeef', match_count: 4
};

async function readMax(sourceRows) {
    const doQuery = sinon.stub().callsFake(async function () {
        if (sourceRows.length === 0) return [];
        return [{ max_batch_seq: Math.max(...sourceRows.map(row => row.match_batch_seq)) }];
    });
    const db = { doQuery };
    const value = await mirrorReads.getMaxArchiveBatchSeqByAuthor.call(db, AUTHOR);
    return { value, query: doQuery.firstCall.args[0], params: doQuery.firstCall.args[1] };
}

function rpcWithMax(value) {
    const view = { getMaxArchiveBatchSeqByAuthor: sinon.stub().resolves(value) };
    const indexerDb = { apiView: sinon.stub().returns(view) };
    return { rpc: buildAnchorRpc({ indexer: { indexerDb, config: { COIN: 'DOGE' } } }), view };
}

describe('getMaxArchiveBatchSeqByAuthor()', function () {
    afterEach(function () { sinon.restore(); });

    it('returns null when the aggregate query has no row', async function () {
        assert.strictEqual((await readMax([])).value, null);
    });

    it('returns the sequence from one matching row', async function () {
        const result = await readMax([{ address: AUTHOR, match_batch_seq: 7 }]);
        assert.strictEqual(result.value, 7);
        assert.deepStrictEqual(result.params, [AUTHOR]);
    });

    it('returns the maximum sequence for several rows owned by the address', async function () {
        const result = await readMax([
            { address: AUTHOR, match_batch_seq: 3 },
            { address: AUTHOR, match_batch_seq: 19 },
            { address: AUTHOR, match_batch_seq: 11 }
        ]);
        assert.strictEqual(result.value, 19);
        assert.match(result.query, /MAX\(a\.match_batch_seq\)/);
        assert.match(result.query, /a\.version = 1/);
        assert.match(result.query, /s\.status IN \('valid', 'unverified'\)/);
        assert.match(result.query, /adr\.address = \?/);
        assert.doesNotMatch(result.query, /batch_crc32|match_count/);
    });
});

describe('validateArchiveAnchorParams() author-only lookup', function () {
    it('accepts author alone as a distinct request shape', function () {
        assert.deepStrictEqual(validateArchiveAnchorParams({ author: AUTHOR }),
            { ok: true, author: AUTHOR, author_only: true });
    });

    it('continues to require the full content key for every other shape', function () {
        assert.strictEqual(validateArchiveAnchorParams({ author: AUTHOR, chain: 'BTC' }).ok, false);
        assert.strictEqual(validateArchiveAnchorParams(CONTENT_KEY).ok, true);
        assert.strictEqual(validateArchiveAnchorParams(
            Object.assign({}, CONTENT_KEY, { batch_crc32: undefined })).ok, false);
        assert.strictEqual(validateArchiveAnchorParams(
            Object.assign({}, CONTENT_KEY, { match_count: undefined })).ok, false);
    });
});

describe('getarchiveanchor author-only lookup', function () {
    afterEach(function () { sinon.restore(); });

    it('returns the highest stored sequence for a hit', async function () {
        const { rpc, view } = rpcWithMax(23);
        assert.deepStrictEqual(await rpc.getarchiveanchor({ author: AUTHOR }),
            { exists: true, match_batch_seq: 23 });
        sinon.assert.calledOnceWithExactly(view.getMaxArchiveBatchSeqByAuthor, AUTHOR);
    });

    it('returns a definitive null for a miss', async function () {
        const { rpc, view } = rpcWithMax(null);
        assert.deepStrictEqual(await rpc.getarchiveanchor({ author: AUTHOR }),
            { exists: false, match_batch_seq: null });
        sinon.assert.calledOnceWithExactly(view.getMaxArchiveBatchSeqByAuthor, AUTHOR);
    });
});
