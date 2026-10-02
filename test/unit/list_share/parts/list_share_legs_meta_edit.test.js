'use strict';

const assert = require('assert');
const {
    planListShareLegs,
    listShareLegTx,
} = require('../../../../src/consensus/list_share_settle/legs.js');

const base = {
    seq: 2,
    listType: 2,
    added: [],
    removed: [],
    mirrorIndex: 77,
    metaActive: true,
    meta: { name: 'Friends', description: 'People I know' },
    currentMeta: { name: 'Old friends', description: 'People I know' },
};

describe('list share edit leg metadata', function () {
    it('plans one metadata leg for a rename-only version', function () {
        assert.deepStrictEqual(planListShareLegs(base), [{
            fields: ['LIST', '5', '77', 'Friends', 'People I know', ''],
            ordinal: 2,
        }]);
    });

    it('plans metadata after removal and addition legs', function () {
        assert.deepStrictEqual(planListShareLegs({
            ...base,
            added: ['carol'],
            removed: ['alice'],
        }), [{
            fields: ['LIST', '1', '2', '77', '', 'alice'],
            ordinal: 0,
        }, {
            fields: ['LIST', '1', '1', '77', '', 'carol'],
            ordinal: 1,
        }, {
            fields: ['LIST', '5', '77', 'Friends', 'People I know', ''],
            ordinal: 2,
        }]);
    });

    it('does not plan metadata when it is unchanged', function () {
        assert.deepStrictEqual(planListShareLegs({
            ...base,
            currentMeta: { name: 'Friends', description: 'People I know' },
        }), []);
    });

    it('sends the name again when clearing the description', function () {
        assert.deepStrictEqual(planListShareLegs({
            ...base,
            meta: { name: 'Friends', description: '' },
            currentMeta: { name: 'Friends', description: 'People I know' },
        }), [{
            fields: ['LIST', '5', '77', 'Friends', '-', ''],
            ordinal: 2,
        }]);
    });

    it('sends clear sentinels for both cleared fields', function () {
        assert.deepStrictEqual(planListShareLegs({
            ...base,
            meta: { name: null },
        }), [{
            fields: ['LIST', '5', '77', '-', '-', ''],
            ordinal: 2,
        }]);
    });

    it('treats null, absent, and empty fields as no metadata', function () {
        assert.deepStrictEqual(planListShareLegs({
            ...base,
            meta: { name: '', description: null },
            currentMeta: {},
        }), []);

        assert.deepStrictEqual(planListShareLegs({
            ...base,
            meta: { name: 'Friends', description: '' },
            currentMeta: null,
        }), [{
            fields: ['LIST', '5', '77', 'Friends', '-', ''],
            ordinal: 2,
        }]);
    });

    it('keeps current edit legs while metadata is inactive', function () {
        assert.deepStrictEqual(planListShareLegs({
            ...base,
            added: ['carol'],
            metaActive: false,
        }), [{
            fields: ['LIST', '1', '1', '77', '', 'carol'],
            ordinal: 1,
        }]);
    });

    it('keeps current edit legs when metadata is null', function () {
        assert.deepStrictEqual(planListShareLegs({
            ...base,
            removed: ['alice'],
            meta: null,
        }), [{
            fields: ['LIST', '1', '2', '77', '', 'alice'],
            ordinal: 0,
        }]);
    });

    it('uses the metadata ordinal as the synthetic transaction vout', function () {
        const [leg] = planListShareLegs(base);

        assert.strictEqual(listShareLegTx(leg, {
            snapshotId: 'f'.repeat(64),
            owner: 'addr',
            blockIndex: 10,
            blockTime: 20,
        }).vout, 2);
    });
});
