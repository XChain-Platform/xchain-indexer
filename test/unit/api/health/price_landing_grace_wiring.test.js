/**
 * Unit: price_landing_wait stall class and its dedicated priceLandingGraceMs
 *
 * The class is judged against priceLandingGraceMs, and BOTH production callers
 * (/status and the health advance fields) must pass that field from the indexer.
 */

'use strict';

const assert = require('assert');
const { stallClassOf, stallWedged } = require('../../../../src/XChainIndexer/stall_health.js');
const { advanceFields } = require('../../../../src/api/health/advance_fields.js');
const { statusVerdict } = require('../../../../src/api/status_route.js');
const XChainIndexer = require('../../../../src/XChainIndexer');

const NOW = 10000000;
const GRACE = 120000;
const LANDING_GRACE = 600000;

function fakeIndexer(ageMs, reason){
    return {
        stallReason: reason, stallClearsAt: null, lastBlockCommittedAt: NOW - ageMs,
        healthStallGraceMs: GRACE, priceLandingGraceMs: LANDING_GRACE,
        isPollSilent: () => false, lastPollAt: NOW, isSynced: () => false
    };
}

describe('price_landing_wait grace wiring @regression', function () {
    it('classifies a landing stall inside its own grace as price_landing_wait', function () {
        assert.strictEqual(stallClassOf('price_landing_barrier', NOW - 300000, GRACE, NOW, null, LANDING_GRACE), 'price_landing_wait');
        assert.strictEqual(stallWedged('price_landing_barrier', NOW - 300000, GRACE, NOW, null, LANDING_GRACE), false);
    });

    it('wedges a landing stall only past priceLandingGraceMs', function () {
        assert.strictEqual(stallClassOf('price_landing_barrier', NOW - 700000, GRACE, NOW, null, LANDING_GRACE), 'wedged');
    });

    it('leaves other reasons on the generic grace', function () {
        assert.strictEqual(stallClassOf('price_sync_barrier', NOW - 300000, GRACE, NOW, null, LANDING_GRACE), 'wedged');
    });

    it('advanceFields passes priceLandingGraceMs', function () {
        const f = advanceFields(fakeIndexer(300000, 'price_landing_barrier'), NOW);
        assert.strictEqual(f.stallClass, 'price_landing_wait');
        assert.strictEqual(f.degraded, true);
        assert.strictEqual(advanceFields(fakeIndexer(700000, 'price_landing_barrier'), NOW).stallClass, 'wedged');
    });

    it('/status verdict passes priceLandingGraceMs', function () {
        const realNow = Date.now;
        Date.now = () => NOW;
        try {
            const v = statusVerdict(XChainIndexer, fakeIndexer(300000, 'price_landing_barrier'));
            assert.strictEqual(v.stallClass, 'price_landing_wait');
            assert.strictEqual(v.wedged, false);
            assert.strictEqual(statusVerdict(XChainIndexer, fakeIndexer(700000, 'price_landing_barrier')).wedged, true);
        } finally { Date.now = realNow; }
    });
});
