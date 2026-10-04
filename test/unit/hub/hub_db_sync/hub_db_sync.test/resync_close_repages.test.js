// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
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

const { makeCloseCodeHarness } = require('./helpers/close_code_harness.js');

async function assertNextDrainStartsAt(harness, expectedPosition) {
    const sync = harness.sync;
    sinon.stub(sync, 'localColumns').resolves(new Set(['id', 'chain']));
    sinon.stub(sync, 'mirrorNetworkScope').resolves(null);
    sinon.stub(sync, 'applyRow').resolves();
    const httpGet = sinon.stub(sync, 'httpGet').resolves({ rows: [], watermark: 9 });

    await sync.bootstrapTable('state_checkpoints');

    assert.match(httpGet.firstCall.args[0],
        new RegExp('[?&]since_id=' + expectedPosition + '(?:&|$)'));
}

describe('HubDbSync resync close re-pages @regression @tier1', function () {
    let harness;

    afterEach(async function () {
        if (harness) await harness.restore();
        harness = null;
        sinon.restore();
    });

    it('re-pages from zero after a resync close with the same hub instance', async function () {
        harness = await makeCloseCodeHarness();
        await harness.connect({ instanceId: 'hub-a' });
        harness.seedPositions({ state_checkpoints: 37 });

        await harness.closeFromHub(1012);
        await harness.connect({ instanceId: 'hub-a' });

        await assertNextDrainStartsAt(harness, 0);
    });

    for (const closeCase of [
        { label: 'an abnormal close', closeCode: null },
        { label: 'a normal close', closeCode: 1000 }
    ]) {
        it('resumes the stored position after ' + closeCase.label, async function () {
            harness = await makeCloseCodeHarness();
            await harness.connect({ instanceId: 'hub-a' });
            harness.seedPositions({ state_checkpoints: 37 });

            await harness.closeFromHub(closeCase.closeCode);
            await harness.connect({ instanceId: 'hub-a' });

            await assertNextDrainStartsAt(harness, 37);
        });
    }

    it('re-pages from zero when the hub instance changes', async function () {
        harness = await makeCloseCodeHarness();
        await harness.connect({ instanceId: 'hub-a' });
        harness.seedPositions({ state_checkpoints: 37 });

        await harness.closeFromHub(1000);
        await harness.connect({ instanceId: 'hub-b' });

        await assertNextDrainStartsAt(harness, 0);
    });
});
