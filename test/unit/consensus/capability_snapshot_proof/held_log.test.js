/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const gates = require('../../../../src/consensus/gate_registry.js');
const { getLogger } = require('../../../../src/observability/index.js');
const { createHeldLog } = require('../../../../src/consensus/capability_snapshot_proof/held_log.js');
const { verifyCapabilitySnapshotRow } = require('../../../../src/db/database/stake_weights.js');

const KEY = 'capability_snapshot_proof_activation.CAPABILITY_SNAPSHOT_PROOF_ACTIVATION';

function row(overrides = {}){
    return Object.assign({ snapshot_block: 95, capability: 'oracle_publish',
        signing_pubkey: 'c'.repeat(64), source: 'seed:' + 'c'.repeat(64), amount: '1' }, overrides);
}

afterEach(function () { sinon.restore(); });

describe('capability snapshot proof held-reason diagnostic @regression @tier1', function () {
    it('logs a held row once a minute per row with its reason', function () {
        let clock = 0;
        const warn = sinon.spy();
        const log = createHeldLog({ warn, now: () => clock });
        assert.strictEqual(log(row(), 'HTTP 503'), true);
        assert.strictEqual(warn.firstCall.args[0],
            'Capability snapshot proof held for snapshot_block 95 capability oracle_publish: HTTP 503');
        clock = 59999;
        assert.strictEqual(log(row(), 'HTTP 503'), false);
        assert.strictEqual(log(row({ snapshot_block: 106 }), 'HTTP 404'), true);
        clock = 60000;
        assert.strictEqual(log(row(), 'HTTP 503'), true);
        assert.strictEqual(warn.callCount, 3);
    });

    it('never throws when the logger does', function () {
        const log = createHeldLog({ warn: () => { throw new Error('sink down'); } });
        assert.strictEqual(log(row(), 'x'), false);
    });

    it('names the reason when the hub proof fetch fails on a mirror-resolved row', async function () {
        sinon.stub(gates, 'activeAt').withArgs(KEY).returns(true);
        const warn = sinon.stub(getLogger(), 'warn');
        const actual = await verifyCapabilitySnapshotRow.call(
            { config: { COIN: 'DOGE', NETWORK: 'regtest' } },
            row({ snapshot_block: 4242 }),
            { fetchProof: sinon.stub().rejects(new Error('HTTP 503')), readEnv: () => undefined });
        assert.strictEqual(actual.verdict, 'held');
        assert.ok(warn.args.some(args =>
            args[0] === 'Capability snapshot proof held for snapshot_block 4242 capability oracle_publish: HTTP 503'));
    });
});
