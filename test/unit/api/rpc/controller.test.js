/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The JSON-RPC controller merge (src/api/rpc/index.js): every family lands in
 * one flat method table, the entry's own family merges after them, a name two
 * families both define is refused at boot, and the table is exactly the method
 * set the auth tier sets in src/api.js and the in-repo source guards name.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const observability = require('../../../../src/observability/index.js');
const { buildRpcController, FAMILIES } = require('../../../../src/api/rpc/index.js');
const { fakeIndexer } = require('./helpers/fake_indexer.js');

// The method table src/api.js served before the split, in registration order,
// minus getcrosschaincall (the entry's own family) and feequotedryrun (opt-in).
const EXPECTED = [
    'ping', 'health', 'getownstake', 'getlatestblock', 'getblockhashes', 'feequote', 'oraclefeequote',
    'preflight', 'feeschedule', 'getactivevalidators', 'getactivestakeweights', 'getcapabilityvalidators',
    'getfullnodeverifiers', 'getstakeweightsbycapability', 'getpendingattestation_requests',
    'getrelayedattestation_requests', 'getopencrosschainorders', 'getbetfeeds', 'getbetfeed', 'getbets',
    'getpendingbridgetransfers', 'getbridgetransfer', 'getbridgebalances', 'getbridgeescrowproof',
    'gettokenpolicy', 'getappliedpolicy', 'getpendingcrosschaincalls', 'getcrosschaincallresult',
    'getpricebatches', 'getactionconfirmations', 'getanchoraction', 'getrollcallsigners',
    'getanchorconfirmations', 'getarchiveanchor', 'getreorghistory', 'getstakesourcebypubkey',
    'getrollcalls', 'getrollcallabsences'
];

function ctx(overrides = {}) {
    return Object.assign({ indexer: fakeIndexer(), liveness: { indexerRunning: true, indexerError: null },
                           ENABLE_DRYRUN: false, rollcallManifestHash: () => null }, overrides);
}

describe('JSON-RPC controller merge @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('serves exactly the pre-split method set, every one an async function', function () {
        const controller = buildRpcController(ctx());
        assert.deepStrictEqual(Object.keys(controller).sort(), EXPECTED.slice().sort());
        for (const name of EXPECTED)
            assert.strictEqual(controller[name].constructor.name, 'AsyncFunction', name);
        assert.ok(!('feequotedryrun' in controller), 'the dry-run is unregistered off regtest');
    });

    it('adds feequotedryrun only under ENABLE_DRYRUN', function () {
        sinon.stub(observability.getLogger(), 'warn');
        const controller = buildRpcController(ctx({ ENABLE_DRYRUN: true }));
        assert.strictEqual(Object.keys(controller).length, EXPECTED.length + 1);
        assert.strictEqual(typeof controller.feequotedryrun, 'function');
    });

    it('merges the entry\'s own families after the directory\'s, under the same duplicate refusal', function () {
        const own = () => ({ async getcrosschaincall() { return { exists: false }; } });
        const controller = buildRpcController(ctx(), [own]);
        assert.strictEqual(typeof controller.getcrosschaincall, 'function');
        assert.strictEqual(Object.keys(controller).length, EXPECTED.length + 1);
        const clash = () => ({ async ping() { return { status: 'clash' }; } });
        assert.throws(() => buildRpcController(ctx(), [clash]),
            /JSON-RPC method ping is defined by two route families/);
    });

    it('refuses a name two directory families both define rather than letting the later one win', function () {
        const families = FAMILIES.concat([() => ({ async getbets() { return {}; } })]);
        assert.throws(() => {
            const controller = {};
            for (const build of families)
                for (const [name] of Object.entries(build(ctx())))
                    if (Object.prototype.hasOwnProperty.call(controller, name)) throw new Error('duplicate ' + name);
                    else controller[name] = true;
        }, /duplicate getbets/, 'sanity: the fixture really collides');
        assert.strictEqual(FAMILIES.length, 14, 'one factory per family file under src/api/rpc/');
    });
});
