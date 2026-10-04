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
const net = require('net');

const { makeCloseCodeHarness } = require('./helpers/close_code_harness.js');

function connectionRefused(port) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => {
            socket.destroy();
            reject(new Error('server still accepts connections'));
        });
        socket.once('error', resolve);
    });
}

describe('HubDbSync close code harness', function () {
    let harness;

    afterEach(async function () {
        if (harness) await harness.restore();
        harness = null;
    });

    for (const closeCase of [
        { label: 'a normal close', closeCode: 1000, seenCode: 1000 },
        { label: 'a terminated socket', closeCode: null, seenCode: 1006 }
    ]) {
        it(closeCase.label + ' reaches the client and retains positions for the same instance', async function () {
            harness = await makeCloseCodeHarness();
            await harness.connect({ instanceId: 'hub-a' });
            harness.seedPositions({ state_checkpoints: 17, oracle_prices: 29 });

            await harness.closeFromHub(closeCase.closeCode);

            assert.strictEqual(harness.lastCloseCode, closeCase.seenCode);
            assert.strictEqual(harness.reconnectCalls, 1);
            await harness.connect({ instanceId: 'hub-a' });
            assert.deepStrictEqual(harness.positions(), { state_checkpoints: 17, oracle_prices: 29 });
        });
    }

    it('empties positions when the reconnected hub instance changes', async function () {
        harness = await makeCloseCodeHarness();
        await harness.connect({ instanceId: 'hub-a' });
        harness.seedPositions({ state_checkpoints: 17 });
        await harness.closeFromHub(1000);

        await harness.connect({ instanceId: 'hub-b' });

        assert.deepStrictEqual(harness.positions(), {});
    });

    it('delivers a service-restart close code without asserting position policy', async function () {
        harness = await makeCloseCodeHarness();
        await harness.connect({ instanceId: 'hub-a' });
        harness.seedPositions({ state_checkpoints: 17 });

        await harness.closeFromHub(1012);

        assert.strictEqual(harness.lastCloseCode, 1012);
        assert.strictEqual(harness.reconnectCalls, 1);
    });

    it('restore stops the sync and closes the server', async function () {
        harness = await makeCloseCodeHarness();
        await harness.connect({ instanceId: 'hub-a' });
        const port = Number(new URL(harness.sync.hubUrl).port);

        await harness.restore();

        assert.strictEqual(harness.sync.running, false);
        await connectionRefused(port);
        harness = null;
    });
});
