// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');
const stakeWeights = require('../../../../../src/db/database/stake_weights.js');

const ROW = Object.freeze({
    id: 31,
    snapshot_block: 700,
    capability: 'cross_chain',
    signing_pubkey: 'aa11',
    amount: '25.00000000',
    source: 'validator/one'
});

function makeSync(required){
    const inserted = [];
    const hubDb = { doQuery: sinon.stub().callsFake(async sql => {
        if(/^INSERT/.test(sql)) inserted.push(sql);
        return /^INSERT/.test(sql) ? { affectedRows: 1 } : [];
    }) };
    const authoritativeDb = {
        capabilitySnapshotProofRequired: sinon.stub().returns(required),
        verifyCapabilitySnapshotRow: sinon.stub().rejects(new Error('mirror read unavailable')),
    };
    const sync = new HubDbSync(hubDb, {
        hubUrl: 'http://hub.test', network: 'regtest', authoritativeDb,
    });
    sinon.stub(sync, 'localColumns').resolves(
        new Set(['id', 'snapshot_block', 'capability', 'signing_pubkey', 'amount', 'source']));
    return { sync, inserted, authoritativeDb };
}

function stopRetry(sync){
    if(sync._capabilityProofRetryTimer !== null) clearTimeout(sync._capabilityProofRetryTimer);
    sync._capabilityProofRetryTimer = null;
}

describe('capability snapshot judge failure policy @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('holds a proof-gated row when the pre-proof mirror read throws', async function () {
        const made = makeSync(true);
        sinon.stub(console, 'warn');
        try {
            assert.strictEqual(await made.sync.applyRow('capability_snapshots', ROW), false);
            assert.strictEqual(made.inserted.length, 0);
            assert.strictEqual(made.sync._capabilityProofHolds.size, 1);
            assert.match(console.warn.firstCall.args.join(' '), /holding row/);
        } finally { stopRetry(made.sync); }
    });

    it('keeps legacy apply-on-throw behavior off the proof-gated path', async function () {
        const made = makeSync(false);
        sinon.stub(console, 'warn');
        try {
            await made.sync.applyRow('capability_snapshots', ROW);
            assert.strictEqual(made.inserted.length, 1);
            assert.strictEqual(made.sync._capabilityProofHolds.size, 0);
        } finally { stopRetry(made.sync); }
    });

    it('holds when the proof-gate decision itself throws', async function () {
        const made = makeSync(false);
        made.authoritativeDb.capabilitySnapshotProofRequired.throws(new Error('gate unavailable'));
        sinon.stub(console, 'warn');
        try {
            assert.strictEqual(await made.sync.applyRow('capability_snapshots', ROW), false);
            assert.strictEqual(made.inserted.length, 0);
            assert.strictEqual(made.sync._capabilityProofHolds.size, 1);
        } finally { stopRetry(made.sync); }
    });

    it('never releases a retained hold through an apply-on-throw fallback', async function () {
        const made = makeSync(false);
        sinon.stub(console, 'warn');
        try {
            const options = { retainHold: true };
            assert.strictEqual(await made.sync.refuseUnprovenCapabilitySnapshot(ROW, options), true);
            assert.strictEqual(options.verdict, 'held');
            assert.strictEqual(made.inserted.length, 0);
            assert.strictEqual(made.sync._capabilityProofHolds.size, 1);
        } finally { stopRetry(made.sync); }
    });

    it('requires proof only for a mirror-resolved capability at an active height', function () {
        const required = stakeWeights.capabilitySnapshotProofRequired;
        assert.strictEqual(required.call({ config: { COIN: 'LTC', NETWORK: 'regtest' } }, ROW), true);
        assert.strictEqual(required.call({ config: { COIN: 'BTC', NETWORK: 'regtest' } }, ROW), false);
        assert.strictEqual(required.call({ config: { COIN: 'LTC', NETWORK: 'mainnet' } }, ROW), false);
        assert.strictEqual(required.call({ config: { COIN: 'LTC', NETWORK: 'regtest' } },
            Object.assign({}, ROW, { snapshot_block: '7e2' })), false);
    });
});
