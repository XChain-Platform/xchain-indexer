'use strict';

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
 ********************************************************************/

// The hub-mirror client is an entry (src/hub/hub_db_sync.js) plus a directory of parts,
// each exporting an object of methods the entry installs onto HubDbSync.prototype. The
// shape that split must keep is what the consumers and the vendoring depend on, and none
// of it is checked by the behaviour suites, which drive methods one at a time:
//
//   - every method part is installed, and no two parts define one name (a duplicate
//     would be a second definition of one method, the later part silently winning);
//   - the one export shape survived: `require(...)` IS the class, and the constants,
//     resolvers and ensureTables consumers reach beside it are still attached;
//   - the process environment is read in exactly one part (env.js), so the vendored
//     copy in xchain-explorer never grows a second read site.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const SRC_HUB   = path.resolve(__dirname, '../../../../src/hub');
const HubDbSync = require('../../../../src/hub/hub_db_sync.js');

// Every part under src/hub/hub_db_sync/, walked so a part added later is graded here
// without an edit.
function walkJs(dir) {
    let out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out = out.concat(walkJs(p));
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out.sort();
}
const PARTS = walkJs(path.join(SRC_HUB, 'hub_db_sync'));

// The parts the entry installs (each exports an object of methods; transport.js wraps
// its methods beside the optional WebSocket binding), and the parts it only reads
// (constants, initializers and pure helpers). Every part on disk must be in one list
// or the other, so a new part is classified here before it can be forgotten.
const METHOD_PARTS = [
    'barriers/attest.js', 'barriers/bridge_policy.js', 'barriers/oracle_match_call.js', 'barriers/price.js',
    'barriers/snapshot.js', 'bootstrap/drain.js', 'bootstrap/flush.js', 'bootstrap/verdict.js',
    'chain_identity.js', 'foreign_reconciliation.js', 'lifecycle.js', 'live_events.js', 'mirror_scope.js',
    'retractions.js', 'row_apply.js', 'transport.js', 'watermarks.js',
];
const HELPER_PARTS = [
    'ensure_tables.js', 'env.js', 'instance_state.js', 'mirror_bounds.js', 'mirror_tables.js',
    'mirror_write.js', 'row_upserts.js', 'watermark_config.js', 'watermark_state.js',
];
function methodParts() {
    return METHOD_PARTS.map((rel) => {
        const p = path.join(SRC_HUB, 'hub_db_sync', rel);
        const m = require(p);
        return [p, m.transportMethods ? m.transportMethods : m];
    });
}

describe('HubDbSync parts: the split keeps one class, one export shape and one env read', function () {

    it('classifies every part on disk as installed or read-only, and names none that is absent', function () {
        const onDisk = PARTS.map((p) => path.relative(path.join(SRC_HUB, 'hub_db_sync'), p)).sort();
        assert.deepStrictEqual(onDisk, METHOD_PARTS.concat(HELPER_PARTS).sort(),
            'the parts on disk and the two lists above disagree; a part the entry installs that this ' +
            'suite does not know is a part whose duplicates and underscore names go ungraded');
    });

    it('installs every method of every method part onto the prototype, and no name twice', function () {
        const seen = new Map();
        for (const [p, methods] of methodParts()) {
            for (const name of Object.keys(methods)) {
                if (seen.has(name)) {
                    assert.fail(name + ' is defined by both ' + path.relative(SRC_HUB, seen.get(name)) + ' and ' +
                        path.relative(SRC_HUB, p) + '; the later install would silently replace the earlier');
                }
                seen.set(name, p);
                assert.strictEqual(HubDbSync.prototype[name], methods[name],
                    name + ' from ' + path.relative(SRC_HUB, p) + ' is not the method installed on HubDbSync.prototype');
            }
        }
        assert.ok(seen.size > 100, 'expected the parts to define well over 100 methods, found ' + seen.size);
    });

    it('defines no underscore-prefixed method in any part', function () {
        for (const [p, methods] of methodParts()) {
            for (const name of Object.keys(methods)) {
                assert.ok(!name.startsWith('_'), path.relative(SRC_HUB, p) + ' defines ' + name);
            }
        }
    });

    it('exports the class itself, with the consumer-facing names attached to it', function () {
        assert.strictEqual(typeof HubDbSync, 'function');
        assert.strictEqual(HubDbSync.name, 'HubDbSync');
        const attached = [
            'ensureTables', 'HUB_SYNC_WATERMARK_GRACE_S', 'resolveWatermarkGrace',
            'HUB_SYNC_BARRIER_HOLD_CEILING_S', 'resolveBarrierHoldCeilingMs',
            'HUB_SYNC_WATERMARK_STALL_S', 'HUB_SYNC_WATERMARK_STALL_EXIT_S', 'WATERMARK_STALL_CHECK_MS',
            'resolveWatermarkStallMs', 'watermarkStallVerdict', 'sanitizeHeights', 'heightsAdvanced',
            'PRICE_BATCH_APPLY_ROWS', 'BOOTSTRAP_PROGRESS_INTERVAL_MS', 'priceUpsertSql',
            'PRICE_MIRROR_ROUND_MARGIN', 'PRICE_MIRROR_MIN_PRE_HORIZON_ROUNDS', 'PRICE_MIRROR_LOOKBACK_S',
            'HUB_STATE_TABLES',
        ];
        assert.deepStrictEqual(Object.keys(HubDbSync).sort(), attached.slice().sort(),
            'the names attached to the exported class changed; every consumer reads them off require(...)');
        // The frozen copy, not the live registry: mutating what a caller was handed must
        // not change the module's own membership.
        assert.ok(Object.isFrozen(HubDbSync.HUB_STATE_TABLES));
    });

    it('reads process.env in env.js and nowhere else in the client', function () {
        const readers = [path.join(SRC_HUB, 'hub_db_sync.js')].concat(PARTS)
            .filter((p) => /\bprocess\.env\b/.test(fs.readFileSync(p, 'utf8')))
            .map((p) => path.relative(SRC_HUB, p));
        assert.deepStrictEqual(readers, ['hub_db_sync/env.js']);
    });
});
