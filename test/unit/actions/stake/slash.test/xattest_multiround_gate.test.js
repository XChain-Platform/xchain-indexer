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
//
// The SLASH_ATTEST_MULTIROUND_EXEMPT row and the slot resolver behind it: a
// base-leg XATTEST pair stops being slashable once the gate is active, relay
// legs never do.

const assert = require('assert');
const eq = require('../../../../../src/consensus/equivocation_header.js');
const ProtocolChanges = require('../../../../../src/protocol_changes.js');
const { resolveAttestSlot } = require('../../../../../src/actions/slash/resolve_slot.js');

const KEY = 'protocol_changes.changes.SLASH_ATTEST_MULTIROUND_EXEMPT';
const util = { isNull: (v) => v === null || v === undefined || v === '' };
const baseA = 'req_1' + 'provider_x' + 'e1'.repeat(32) + '1';
const baseB = 'req_1' + 'provider_x' + 'e2'.repeat(32) + '1';
const relay = (provider) => ['ATTEST', 'RELAY_REQUEST', 'req_1', '100', 'regtest', 'LTC', '5',
    provider, 'aa'.repeat(32), '3', '100'].join('|');

function indexerDbWith(block) {
    return { getAttestationRequestById: async () => ({ block_index: block }) };
}

describe('SLASH_ATTEST_MULTIROUND_EXEMPT row and base-leg resolver @regression @tier1', function () {
    it('registers a row unarmed on mainnet and testnet and genesis-active on regtest', function () {
        const row = ProtocolChanges.get(KEY);
        assert.strictEqual(row.mainnet_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.testnet_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.regtest_time, 0);
    });

    it('below the gate a base pair resolves its snapshot block from the request row', async function () {
        const slot = await resolveAttestSlot(util, indexerDbWith(90), eq.ENGINE_TAGS.ATTEST, 'req_1', baseA, baseB, false);
        assert.strictEqual(slot.error, undefined);
        assert.ok(slot.snapshotBlock !== undefined);
    });

    it('at the gate a base pair is refused as a multi-round retry', async function () {
        const slot = await resolveAttestSlot(util, indexerDbWith(90), eq.ENGINE_TAGS.ATTEST, 'req_1', baseA, baseB, true);
        assert.ok(/ATTEST multi-round/.test(slot.error), JSON.stringify(slot));
    });

    it('at the gate a relay pair still resolves under cross_chain', async function () {
        const slot = await resolveAttestSlot(util, indexerDbWith(90), eq.ENGINE_TAGS.ATTEST, 'rr', relay('provider_x'), relay('provider_y'), true);
        assert.deepStrictEqual(slot, { snapshotBlock: 100, capability: 'cross_chain' });
    });
});
