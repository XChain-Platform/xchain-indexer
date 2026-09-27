'use strict';

const assert = require('assert');

const { planListLeg } = require('../../../src/consensus/bridge_settle/policy_list_plan.js');

describe('bridged policy list leg planning', function(){

    it('skips a field absent from the snapshot even when it has a list', function(){
        assert.deepStrictEqual(planListLeg({
            list: ['holder'], hasField: false, detachActive: true, existingIndex: 7
        }), { op: 'skip' });
    });

    it('detaches an existing list for an active null snapshot field', function(){
        assert.deepStrictEqual(planListLeg({
            list: null, hasField: true, detachActive: true, existingIndex: 7
        }), { op: 'detach' });
    });

    it('skips a null list with an existing pointer below detach activation', function(){
        assert.deepStrictEqual(planListLeg({
            list: null, hasField: true, detachActive: false, existingIndex: 7
        }), { op: 'skip' });
    });

    it('skips a null list with no pointer above detach activation', function(){
        assert.deepStrictEqual(planListLeg({
            list: null, hasField: true, detachActive: true, existingIndex: undefined
        }), { op: 'skip' });
    });

    it('creates an empty list when the empty-string pointer means none exists', function(){
        assert.deepStrictEqual(planListLeg({
            list: [], hasField: true, detachActive: false, existingIndex: ''
        }), { op: 'create' });
    });

    it('creates a populated list when its pointer is null', function(){
        assert.deepStrictEqual(planListLeg({
            list: ['holder'], hasField: true, detachActive: false, existingIndex: null
        }), { op: 'create' });
    });

    it('edits an array backed by an existing pointer', function(){
        assert.deepStrictEqual(planListLeg({
            list: ['holder'], hasField: true, detachActive: false, existingIndex: 7
        }), { op: 'edit' });
    });
});
