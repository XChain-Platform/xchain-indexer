'use strict';

const assert = require('assert');

const orphanStatsReads = require('../../../../src/db/subtree/orphan_stats_reads.js');

function recordingQuery(result) {
    const calls = [];
    return {
        calls,
        query(sql, params) {
            calls.push({ sql, params });
            return result;
        }
    };
}

describe('orphan stats reads', function () {
    it('counts all state tree nodes and returns the query result', function () {
        const result = Promise.resolve([{ c: 3 }]);
        const recording = recordingQuery(result);

        const returned = orphanStatsReads.countStateTreeNodes(recording.query);

        assert.strictEqual(returned, result);
        assert.deepStrictEqual(recording.calls, [{
            sql: 'SELECT COUNT(*) AS c FROM state_tree_nodes',
            params: []
        }]);
    });

    it('selects the retained root union for one chain and network', function () {
        const recording = recordingQuery([]);

        orphanStatsReads.selectRetainedRootUnion(recording.query, 'BTC', 'regtest');

        assert.deepStrictEqual(recording.calls, [{
            sql: 'SELECT DISTINCT balances_root AS r FROM state_tree_roots WHERE chain=? AND network=? ' +
                'UNION SELECT DISTINCT stakes_root AS r FROM state_tree_roots WHERE chain=? AND network=? ' +
                'UNION SELECT DISTINCT contract_state_root AS r FROM state_tree_roots WHERE chain=? AND network=? AND contract_state_root IS NOT NULL',
            params: ['BTC', 'regtest', 'BTC', 'regtest', 'BTC', 'regtest']
        }]);
    });

    it('selects node rows with one placeholder for one hash', function () {
        const recording = recordingQuery([]);

        orphanStatsReads.selectNodeRowsByHash(recording.query, ['hash-a']);

        assert.deepStrictEqual(recording.calls, [{
            sql: 'SELECT node_hash, left_hash, right_hash FROM state_tree_nodes ' +
                'WHERE node_hash IN (?)',
            params: ['hash-a']
        }]);
    });

    it('selects node rows with one placeholder per hash', function () {
        const recording = recordingQuery([]);
        const hashes = ['hash-a', 'hash-b', 'hash-c'];

        orphanStatsReads.selectNodeRowsByHash(recording.query, hashes);

        assert.deepStrictEqual(recording.calls, [{
            sql: 'SELECT node_hash, left_hash, right_hash FROM state_tree_nodes ' +
                'WHERE node_hash IN (?,?,?)',
            params: hashes
        }]);
    });
});
