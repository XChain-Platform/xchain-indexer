'use strict';

const assert = require('assert');
const {
    planListShareLegs,
} = require('../../../../src/consensus/list_share_settle/legs.js');

const base = {
    seq: 1,
    listType: 2,
    added: ['alice', 'bob'],
    removed: [],
    mirrorIndex: null,
};

describe('list share leg metadata', function () {
    it('uses the format 0 create leg with metadata defaults', function () {
        assert.deepStrictEqual(planListShareLegs(base), [{
            fields: ['LIST', '0', '2', '', 'alice', 'bob'],
            ordinal: 0,
        }]);
    });

    it('uses the format 0 create leg while metadata is inactive', function () {
        assert.deepStrictEqual(planListShareLegs({
            ...base,
            metaActive: false,
            meta: { name: 'Friends', description: 'People I know' },
        }), [{
            fields: ['LIST', '0', '2', '', 'alice', 'bob'],
            ordinal: 0,
        }]);
    });

    it('uses the format 0 create leg for empty active metadata', function () {
        assert.deepStrictEqual(planListShareLegs({
            ...base,
            metaActive: true,
            meta: { name: '', description: '' },
        }), [{
            fields: ['LIST', '0', '2', '', 'alice', 'bob'],
            ordinal: 0,
        }]);
    });

    it('uses the format 4 create leg with a name', function () {
        assert.deepStrictEqual(planListShareLegs({
            ...base,
            metaActive: true,
            meta: { name: 'Friends', description: '' },
        }), [{
            fields: ['LIST', '4', '2', 'Friends', '', '', 'alice', 'bob'],
            ordinal: 0,
        }]);
    });

    it('uses the format 4 create leg with a description', function () {
        assert.deepStrictEqual(planListShareLegs({
            ...base,
            metaActive: true,
            meta: { name: '', description: 'People I know' },
        }), [{
            fields: ['LIST', '4', '2', '', 'People I know', '', 'alice', 'bob'],
            ordinal: 0,
        }]);
    });

    it('uses the format 4 create leg with a name and description', function () {
        assert.deepStrictEqual(planListShareLegs({
            ...base,
            metaActive: true,
            meta: { name: 'Friends', description: 'People I know' },
        }), [{
            fields: ['LIST', '4', '2', 'Friends', 'People I know', '', 'alice', 'bob'],
            ordinal: 0,
        }]);
    });

    it('ignores metadata for an edit leg', function () {
        assert.deepStrictEqual(planListShareLegs({
            ...base,
            seq: 2,
            added: ['carol'],
            removed: ['alice'],
            mirrorIndex: 77,
            metaActive: true,
            meta: { name: 'Friends', description: 'People I know' },
        }), [{
            fields: ['LIST', '1', '2', '77', '', 'alice'],
            ordinal: 0,
        }, {
            fields: ['LIST', '1', '1', '77', '', 'carol'],
            ordinal: 1,
        }]);
    });
});
