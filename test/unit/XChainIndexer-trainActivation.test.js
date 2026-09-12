/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The platform-train consensus activation gate (release-management section 13).
 *
 * WHAT IS ACTUALLY BEING ASSERTED. Not that a field is set, but the two BEHAVIOURS
 * the section rules and the ~30 per-feature flag days beside it cannot provide:
 *
 *   1. A node whose code carries no entry for the rule set its signed manifest
 *      requires DOES NOT APPLY the first block at or above the activation height.
 *      The block loop's gate returns "do not apply", the stall reason names the
 *      required rule set, and a durable marker is written so a restart cannot
 *      forget it. Continue-old is the failure this exists to prevent, and it is
 *      silent: the node looks healthy while it writes forked state.
 *
 *   2. The halt is ANNOUNCED BEFORE IT FIRES. Below the activation height the same
 *      manifest yields `pending`, the block IS applied, and the verdict an operator
 *      reads already names the height and the version needed.
 *
 * The coercion cases are here for a reason that is easy to lose: Number(null) is 0
 * and Number('') is 0, so a service with no BTC clock would read the launch floor as
 * active and wave every block through. That is a silent fork produced by a bare
 * Number(), which is why asHeight exists and why it is asserted directly.
 *********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');

const ta            = require('../../src/train_activation.js');
const XChainIndexer = require('../../src/XChainIndexer.js');

const FLOOR   = { '1.0.0': { mainnet: 0, testnet: 0, regtest: 0 } };
const TWO_ARM = { '1.0.0': { mainnet: 0, testnet: 0, regtest: 0 },
                  '2.0.0': { mainnet: 970000, testnet: 150000, regtest: 0 } };

function manifest(block){ return block === undefined ? {} : { trainActivation: block }; }
function armed(version, heights){
    return { ruleSetVersion: version, classification: 'major', heights: heights,
             computedFromBtcTip: { mainnet: 0, testnet: 0, regtest: 0 } };
}

describe('train activation: resolution @regression', function () {

    it('resolves the greatest entry at or below the height among the entries the build carries', function () {
        assert.strictEqual(ta.resolveRuleSet(969999, 'mainnet', TWO_ARM), '1.0.0');
        assert.strictEqual(ta.resolveRuleSet(970000, 'mainnet', TWO_ARM), '2.0.0');
        assert.strictEqual(ta.resolveRuleSet(1e9,    'mainnet', TWO_ARM), '2.0.0');
        // Regtest is 0 on every row, so a fresh stack is on the newest rule set at genesis.
        assert.strictEqual(ta.resolveRuleSet(0, 'regtest', TWO_ARM), '2.0.0');
    });

    it('orders rule sets numerically, not lexically', function () {
        // '10.0.0' sorts BEFORE '2.0.0' as a string, which would resolve a height above
        // both to the older rule set and apply the wrong rules on every block after it.
        const map = { '2.0.0': { mainnet: 100 }, '10.0.0': { mainnet: 200 } };
        assert.strictEqual(ta.resolveRuleSet(250, 'mainnet', map), '10.0.0');
        assert.deepStrictEqual(ta.implementedRuleSets(map), ['2.0.0', '10.0.0']);
    });

    it('treats an absent network as undecided rather than as zero', function () {
        const map = { '2.0.0': { mainnet: 100 } };
        assert.strictEqual(ta.activationHeightFor('2.0.0', 'testnet', map), null);
        assert.strictEqual(ta.resolveRuleSet(1000, 'testnet', map), null);
    });

    it('refuses to coerce a missing height into genesis', function () {
        for (const bad of [null, undefined, '', 'abc', true, false, NaN, {}]) {
            assert.strictEqual(ta.asHeight(bad), null, JSON.stringify(bad) + ' must not read as a height');
            assert.strictEqual(ta.resolveRuleSet(bad, 'mainnet', FLOOR), null);
        }
        assert.strictEqual(ta.asHeight(0), 0);
        assert.strictEqual(ta.asHeight('42'), 42);
    });

    it('throws on an unorderable rule-set version rather than sorting it somewhere', function () {
        assert.throws(() => ta.compareRuleSetVersions('1.0', '1.0.0'), /unparseable rule-set version/);
    });
});

describe('train activation: the halt boundary @regression', function () {

    it('is CLEAR when nothing requires a rule set the build does not implement', function () {
        assert.strictEqual(ta.evaluateTrainActivation({
            height: 970001, network: 'mainnet', manifest: manifest(undefined), activation: FLOOR
        }).status, 'clear');
    });

    it('is CLEAR at any height when the build DOES implement the required rule set', function () {
        for (const h of [0, 969999, 970000, 1e9, null]) {
            const v = ta.evaluateTrainActivation({
                height: h, network: 'mainnet', activation: TWO_ARM,
                manifest: manifest(armed('2.0.0', { mainnet: 970000 }))
            });
            assert.strictEqual(v.status, 'clear', 'height ' + h + ' must be clear on an implementing build');
        }
    });

    it('is PENDING below the boundary and names the height and the version needed', function () {
        const v = ta.evaluateTrainActivation({
            height: 969999, network: 'mainnet', activation: FLOOR,
            manifest: manifest(armed('2.0.0', { mainnet: 970000 }))
        });
        assert.strictEqual(v.status, 'pending');
        assert.strictEqual(v.requiredRuleSet, '2.0.0');
        assert.strictEqual(v.requiredAtHeight, 970000);
        assert.strictEqual(v.activeRuleSet, '1.0.0');
        assert.match(v.reason, /970000/);
        assert.match(v.reason, /2\.0\.0/);
    });

    it('HALTS at the boundary block, not one block after it', function () {
        const at = (h) => ta.evaluateTrainActivation({
            height: h, network: 'mainnet', activation: FLOOR,
            manifest: manifest(armed('2.0.0', { mainnet: 970000 }))
        }).status;
        assert.strictEqual(at(969999), 'pending');
        // The boundary block itself is the one that must not be applied under the old
        // rules. An off-by-one here applies exactly one forked block, which is all it
        // takes: the sync followers then halt on the divergence it wrote.
        assert.strictEqual(at(970000), 'halt');
        assert.strictEqual(at(970001), 'halt');
    });

    it('HALTS with no BTC clock, because the boundary cannot be proven to be ahead', function () {
        const v = ta.evaluateTrainActivation({
            height: null, network: 'mainnet', activation: FLOOR,
            manifest: manifest(armed('2.0.0', { mainnet: 970000 }))
        });
        assert.strictEqual(v.status, 'halt');
        assert.match(v.reason, /no BTC height to compare against/);
    });

    it('HALTS when the manifest names no activation height for this network', function () {
        const v = ta.evaluateTrainActivation({
            height: 10, network: 'regtest', activation: FLOOR,
            manifest: manifest(armed('2.0.0', { mainnet: 970000 }))
        });
        assert.strictEqual(v.status, 'halt');
        assert.match(v.reason, /names no activation height/);
    });

    it('HALTS on a manifest block it cannot read, rather than reading it as no requirement', function () {
        for (const bad of [{ ruleSetVersion: 'two' }, { ruleSetVersion: '2.0.0' }, [], 'nope']) {
            const v = ta.evaluateTrainActivation({
                height: 10, network: 'mainnet', activation: FLOOR, manifest: manifest(bad)
            });
            assert.strictEqual(v.status, 'halt', JSON.stringify(bad) + ' must be fail-closed');
        }
    });

    it('reads no requirement out of a manifest that carries none', function () {
        assert.strictEqual(ta.readManifestTrainActivation({}), null);
        assert.strictEqual(ta.readManifestTrainActivation({ trainActivation: null }), null);
        assert.strictEqual(ta.readManifestTrainActivation(null), null);
    });
});

/* ------------------------------------------------------------------ *
 *  The block loop's pre-apply gate
 *
 *  Exercised through the prototype against a minimal `this`, which is what keeps
 *  these cases about the DECISION (apply / do not apply, what is recorded, what is
 *  announced) instead of about booting an indexer with two databases.
 * ------------------------------------------------------------------ */

function fakeIndexer(opts){
    const o = opts || {};
    const queries = [];
    return {
        config: { COIN: o.coin || 'BTC', NETWORK: o.network || 'mainnet',
                  RELEASE_MANIFEST_PATH: o.manifestPath },
        stallReason: o.stallReason === undefined ? null : o.stallReason,
        stallClearsAt: null,
        trainActivation: null,
        _trainActivationHaltLogTick: 0,
        _trainActivationRequired: o.required,
        queries,
        indexerDb: {
            doQuery: async (sql, params) => {
                queries.push([sql, params]);
                if (/^SELECT id FROM events/.test(sql)) return o.existingMarker ? [{ id: 7 }] : [];
                return { affectedRows: 1 };
            }
        },
        _resolveTrainActivationRequirement: XChainIndexer.prototype._resolveTrainActivationRequirement,
        _recordTrainActivationHalt: XChainIndexer.prototype._recordTrainActivationHalt
    };
}

const check = (self, block) => XChainIndexer.prototype._checkTrainActivation.call(self, block);

describe('train activation: the indexer pre-apply gate @regression', function () {

    it('applies the block and reports nothing when the manifest requires nothing', function () {
        const self = fakeIndexer({ required: null });
        return check(self, 900000).then((stop) => {
            assert.strictEqual(stop, false, 'the block must be applied');
            assert.strictEqual(self.trainActivation.status, 'clear');
            assert.strictEqual(self.queries.length, 0, 'no marker is written on a clear verdict');
        });
    });

    it('applies the block below the boundary while publishing the pending verdict', function () {
        const self = fakeIndexer({ required: armed('9.0.0', { mainnet: 970000 }) });
        return check(self, 969999).then((stop) => {
            assert.strictEqual(stop, false, 'the rolling-upgrade window must keep the node advancing');
            assert.strictEqual(self.trainActivation.status, 'pending');
            assert.strictEqual(self.trainActivation.requiredRuleSet, '9.0.0');
            assert.strictEqual(self.stallReason, null, 'a pending verdict is not a stall');
            assert.strictEqual(self.queries.length, 0, 'no durable marker before the boundary');
        });
    });

    it('REFUSES the boundary block, names the reason, and records a durable marker', function () {
        const self = fakeIndexer({ required: armed('9.0.0', { mainnet: 970000 }) });
        return check(self, 970000).then((stop) => {
            assert.strictEqual(stop, true, 'the boundary block must NOT be applied');
            assert.strictEqual(self.trainActivation.status, 'halt');
            assert.match(self.stallReason, /^train_activation_halt: /);
            assert.match(self.stallReason, /9\.0\.0/);
            const insert = self.queries.find(([sql]) => /INSERT INTO events/.test(sql));
            assert.ok(insert, 'a durable TRAIN_ACTIVATION_HALT marker must be written');
            assert.match(insert[0], /TRAIN_ACTIVATION_HALT/);
            const payload = JSON.parse(insert[1][0]);
            assert.strictEqual(payload.requiredRuleSet, '9.0.0');
            assert.strictEqual(payload.requiredAtHeight, 970000);
            assert.strictEqual(payload.haltedAtBlock, 970000);
            assert.ok(insert[1][0].length <= 250, 'the marker payload must fit events.data VARCHAR(250)');
        });
    });

    it('writes the marker once, not once per deferring poll', function () {
        const self = fakeIndexer({ required: armed('9.0.0', { mainnet: 970000 }), existingMarker: true });
        return check(self, 970000).then(() => {
            assert.strictEqual(self.queries.filter(([sql]) => /INSERT INTO events/.test(sql)).length, 0);
        });
    });

    it('still halts when the marker write fails', function () {
        const self = fakeIndexer({ required: armed('9.0.0', { mainnet: 970000 }) });
        self.indexerDb.doQuery = async () => { throw new Error('db down'); };
        return check(self, 970000).then((stop) => {
            assert.strictEqual(stop, true, 'the refusal to advance must not depend on an INSERT');
        });
    });

    it('halts an off-BTC indexer, which has no BTC height to prove the boundary is ahead', function () {
        const self = fakeIndexer({ coin: 'DOGE', required: armed('9.0.0', { mainnet: 970000 }) });
        return check(self, 5000000).then((stop) => {
            assert.strictEqual(stop, true);
            assert.match(self.trainActivation.reason, /no BTC height to compare against/);
        });
    });

    it('does not halt an off-BTC indexer whose build implements the required rule set', function () {
        const self = fakeIndexer({ coin: 'LTC', required: armed('1.0.0', { mainnet: 0 }) });
        return check(self, 4800000).then((stop) => {
            assert.strictEqual(stop, false);
            assert.strictEqual(self.trainActivation.status, 'clear');
        });
    });

    it('halts when the gate itself throws, rather than waving the block through', function () {
        const self = fakeIndexer({});
        self._resolveTrainActivationRequirement = () => { throw new Error('boom'); };
        return check(self, 1).then((stop) => {
            assert.strictEqual(stop, true);
            assert.match(self.trainActivation.reason, /failed to evaluate/);
        });
    });

    it('clears its own stall reason once the verdict goes clear, and leaves other stalls alone', function () {
        const mine = fakeIndexer({ required: null, stallReason: 'train_activation_halt: stale' });
        const other = fakeIndexer({ required: null, stallReason: 'price_sync_barrier' });
        return check(mine, 1).then(() => check(other, 1)).then(() => {
            assert.strictEqual(mine.stallReason, null);
            assert.strictEqual(other.stallReason, 'price_sync_barrier',
                'the train gate must never clear another barrier\'s stall');
        });
    });

    it('reads the requirement out of the manifest file the deployment names', function () {
        const file = path.join(__dirname, 'fixtures-train-activation-manifest.json');
        const fs = require('fs');
        fs.writeFileSync(file, JSON.stringify({
            platform_version: '9.0.0',
            trainActivation: armed('9.0.0', { mainnet: 970000, testnet: 150000, regtest: 0 })
        }));
        try {
            const self = fakeIndexer({ manifestPath: file, required: undefined });
            return check(self, 970000).then((stop) => {
                assert.strictEqual(stop, true, 'the manifest on disk must drive the halt');
                assert.strictEqual(self.trainActivation.requiredRuleSet, '9.0.0');
            });
        } finally {
            fs.unlinkSync(file);
        }
    });

    it('treats an unparseable manifest as a halt, and does not cache the fault', function () {
        const file = path.join(__dirname, 'fixtures-train-activation-broken.json');
        const fs = require('fs');
        fs.writeFileSync(file, '{ not json');
        try {
            const self = fakeIndexer({ manifestPath: file, required: undefined });
            return check(self, 1).then((stop) => {
                assert.strictEqual(stop, true);
                assert.strictEqual(self._trainActivationRequired, undefined,
                    'a resolution fault must not be cached, or a fixed manifest would never be read');
            });
        } finally {
            fs.unlinkSync(file);
        }
    });
});
