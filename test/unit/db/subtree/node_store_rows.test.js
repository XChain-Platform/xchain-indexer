'use strict';

const assert = require('assert');

const {
    NODE_PUT_CHUNK,
    selectNodeRow,
    insertNodeRow,
    insertNodeRows
} = require('../../../../src/db/subtree/node_store_rows.js');

function recordingDb(marker){
    const calls = [];
    return {
        calls,
        db: {
            doQueryStrict(sql, args){
                calls.push({ sql, args });
                return marker;
            }
        }
    };
}

describe('subtree node store single rows', function(){
    it('uses chunks of 128 rows', function(){
        assert.strictEqual(NODE_PUT_CHUNK, 128);
    });

    it('selects child hashes by node hash and returns the query result', function(){
        const marker = { selected: true };
        const { db, calls } = recordingDb(marker);

        const result = selectNodeRow(db, 'node-hash');

        assert.strictEqual(result, marker);
        assert.deepStrictEqual(calls, [{
            sql: 'SELECT left_hash, right_hash FROM state_tree_nodes ' +
                'WHERE node_hash=? LIMIT 1',
            args: ['node-hash']
        }]);
    });

    it('inserts one node in hash, left, right order and returns the query result', function(){
        const marker = { inserted: true };
        const { db, calls } = recordingDb(marker);

        const result = insertNodeRow(db, 'node-hash', 'left-hash', 'right-hash');

        assert.strictEqual(result, marker);
        assert.deepStrictEqual(calls, [{
            sql: 'INSERT IGNORE INTO state_tree_nodes ' +
                '(node_hash, left_hash, right_hash) VALUES (?, ?, ?)',
            args: ['node-hash', 'left-hash', 'right-hash']
        }]);
    });
});

describe('subtree node store row batches', function(){
    it('inserts a one-node chunk and returns the query result', function(){
        const marker = { batch: 'one' };
        const { db, calls } = recordingDb(marker);
        const chunk = [{ hash: 'node-1', left: 'left-1', right: 'right-1' }];

        const result = insertNodeRows(db, chunk);

        assert.strictEqual(result, marker);
        assert.deepStrictEqual(calls, [{
            sql: 'INSERT IGNORE INTO state_tree_nodes ' +
                '(node_hash, left_hash, right_hash) VALUES (?, ?, ?)',
            args: ['node-1', 'left-1', 'right-1']
        }]);
    });

    it('inserts a three-node chunk in node order and returns the query result', function(){
        const marker = { batch: 'three' };
        const { db, calls } = recordingDb(marker);
        const chunk = [
            { hash: 'node-1', left: 'left-1', right: 'right-1' },
            { hash: 'node-2', left: 'left-2', right: 'right-2' },
            { hash: 'node-3', left: 'left-3', right: 'right-3' }
        ];

        const result = insertNodeRows(db, chunk);

        assert.strictEqual(result, marker);
        assert.deepStrictEqual(calls, [{
            sql: 'INSERT IGNORE INTO state_tree_nodes ' +
                '(node_hash, left_hash, right_hash) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)',
            args: [
                'node-1', 'left-1', 'right-1',
                'node-2', 'left-2', 'right-2',
                'node-3', 'left-3', 'right-3'
            ]
        }]);
    });
});
