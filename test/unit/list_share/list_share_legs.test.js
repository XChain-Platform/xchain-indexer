'use strict';

const assert = require('assert');
const {
    planListShareLegs,
    listShareLegTx,
} = require('../../../src/consensus/list_share_settle/legs.js');

function registerCreateAndCombinedDeltaTests() {
    it('plans the version 1 create leg', function () {
        assert.deepStrictEqual(planListShareLegs({
            seq: 1,
            listType: 2,
            added: ['alice', 'bob'],
            removed: [],
            mirrorIndex: null,
        }), [{
            fields: ['LIST', '0', '2', '', 'alice', 'bob'],
            ordinal: 0,
        }]);
    });

    it('plans removal before addition with pinned ordinals', function () {
        assert.deepStrictEqual(planListShareLegs({
            seq: 2,
            listType: 2,
            added: ['carol'],
            removed: ['alice'],
            mirrorIndex: 77,
        }), [{
            fields: ['LIST', '1', '2', '77', '', 'alice'],
            ordinal: 0,
        }, {
            fields: ['LIST', '1', '1', '77', '', 'carol'],
            ordinal: 1,
        }]);
    });
}

function registerSingleSidedDeltaTests() {
    it('plans a removal-only delta', function () {
        assert.deepStrictEqual(planListShareLegs({
            seq: 2,
            listType: 2,
            added: [],
            removed: ['alice'],
            mirrorIndex: 77,
        }), [{
            fields: ['LIST', '1', '2', '77', '', 'alice'],
            ordinal: 0,
        }]);
    });

    it('plans an addition-only delta', function () {
        assert.deepStrictEqual(planListShareLegs({
            seq: 2,
            listType: 2,
            added: ['carol'],
            removed: [],
            mirrorIndex: 77,
        }), [{
            fields: ['LIST', '1', '1', '77', '', 'carol'],
            ordinal: 1,
        }]);
    });

    it('returns no leg for an empty delta', function () {
        assert.deepStrictEqual(planListShareLegs({
            seq: 2,
            listType: 2,
            added: [],
            removed: [],
            mirrorIndex: 77,
        }), []);
    });
}

function registerValidationTests() {
    it('rejects a non-array added value', function () {
        assert.throws(() => planListShareLegs({
            seq: 1, listType: 2, added: 'alice', removed: [], mirrorIndex: null,
        }), TypeError);
    });

    it('rejects a non-array removed value', function () {
        assert.throws(() => planListShareLegs({
            seq: 1, listType: 2, added: [], removed: 'alice', mirrorIndex: null,
        }), TypeError);
    });

    it('rejects a seq that is not a positive safe integer', function () {
        for(const seq of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]){
            assert.throws(() => planListShareLegs({
                seq, listType: 2, added: [], removed: [], mirrorIndex: null,
            }), TypeError);
        }
    });

    it('rejects a later seq without a positive mirror index', function () {
        for(const mirrorIndex of [null, 0, -1, 1.5, '77', Number.MAX_SAFE_INTEGER + 1]){
            assert.throws(() => planListShareLegs({
                seq: 2, listType: 2, added: [], removed: [], mirrorIndex,
            }), TypeError);
        }
    });
}

function registerTransactionTests() {
    it('builds the synthetic transaction shape', function () {
        const snapshotId = 'f'.repeat(64);
        const leg = {
            fields: ['LIST', '1', '1', '77', '', 'carol'],
            ordinal: 1,
        };

        assert.deepStrictEqual(listShareLegTx(leg, {
            snapshotId,
            owner: 'addr',
            blockIndex: 10,
            blockTime: 20,
        }), {
            data:          'LIST|1|1|77||carol',
            source:        'addr',
            destination:   null,
            amount:        null,
            tx_hash:       'LIST_SHARE-' + 'f'.repeat(48),
            vout:          1,
            block_index:   10,
            block_time:    20,
            raw_data:      null,
            fee:           null,
            source_pubkey: null,
            tx_outputs:    [],
        });
    });
}

describe('list share legs', function () {
    registerCreateAndCombinedDeltaTests();
    registerSingleSidedDeltaTests();
    registerValidationTests();
    registerTransactionTests();
});
