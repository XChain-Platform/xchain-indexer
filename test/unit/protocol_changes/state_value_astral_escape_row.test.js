'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const ProtocolChanges = require('../../../src/protocol_changes.js');
const changes = require('../../../src/protocol_changes/changes_5.js');
const { STATE_VALUE_ASTRAL_ESCAPE_TESTNET_TIME } = require('../../../src/protocol_changes/flag_times.js');
const { STATE_VALUE_ASTRAL_ESCAPE } = require('../../../src/actions/execute/state_value_text.js');

const KEY = 'protocol_changes.changes.STATE_VALUE_ASTRAL_ESCAPE';

function build(network, time) {
    return new ProtocolChanges({
        config: { NETWORK: network },
        util: {},
        decoderDb: { getBlockTime: async () => time },
    });
}

describe('protocol_changes STATE_VALUE_ASTRAL_ESCAPE row @regression @tier1', function () {
    it('is a part 5 time row: unarmed on mainnet, 2026-11-17T00:00Z on testnet, genesis on regtest', function () {
        const entry = changes.find((row) => row[0] === 'STATE_VALUE_ASTRAL_ESCAPE');
        const table = new ProtocolChanges({ config: {}, util: {} }).changes.STATE_VALUE_ASTRAL_ESCAPE;

        assert.ok(entry, 'row missing from changes_5.js');
        assert.strictEqual(entry[0], STATE_VALUE_ASTRAL_ESCAPE, 'the writers gate on the registered name');
        assert.strictEqual(entry[1], '0.2.0');
        assert.strictEqual(entry[2], ProtocolChanges.UNARMED);
        assert.strictEqual(entry[3], 1794873600);
        assert.deepStrictEqual(entry.slice(4), [0, 0, 0, 0]);
        assert.strictEqual(STATE_VALUE_ASTRAL_ESCAPE_TESTNET_TIME, 1794873600);
        assert.strictEqual(new Date(1794873600 * 1000).toISOString(), '2026-11-17T00:00:00.000Z');
        assert.deepStrictEqual(table, ProtocolChanges.get(KEY));
    });

    it('is dark on mainnet, activates at the testnet instant, and is active at regtest genesis', async function () {
        assert.strictEqual(await build('mainnet', ProtocolChanges.UNARMED - 1).isEnabled('STATE_VALUE_ASTRAL_ESCAPE', 0), false);
        assert.strictEqual(await build('testnet', STATE_VALUE_ASTRAL_ESCAPE_TESTNET_TIME - 1).isEnabled('STATE_VALUE_ASTRAL_ESCAPE', 0), false);
        assert.strictEqual(await build('testnet', STATE_VALUE_ASTRAL_ESCAPE_TESTNET_TIME).isEnabled('STATE_VALUE_ASTRAL_ESCAPE', 0), true);
        assert.strictEqual(await build('regtest', 0).isEnabled('STATE_VALUE_ASTRAL_ESCAPE', 0), true);
    });
});
