/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * Unit coverage for roll-call request validation and presence mapping.
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const {
    ROLLCALL_READ_MAX_KEYS,
    rollcallSignersRequest,
    rollcallPresence
} = require('../../../src/api/rollcall_signers');

const KEY = 'A'.repeat(64);
const OTHER_KEY = 'B'.repeat(64);
const SIG = 'C'.repeat(64);
const LEDGER_HASH = 'D'.repeat(64);
const PUBLISHER = 'E'.repeat(64);
const CONFIG = { COIN: 'DOGE', NETWORK: 'regtest' };

describe('rollcall signer request validation', function () {
    it('rejects a non-DOGE configuration', function () {
        assert.deepStrictEqual(rollcallSignersRequest(
            { COIN: 'BTC', NETWORK: 'regtest' }, {}
        ), { error: 'getrollcallsigners is DOGE-only' });
    });

    it('rejects a different requested network', function () {
        assert.deepStrictEqual(rollcallSignersRequest(
            CONFIG, { network: 'mainnet' }
        ), { error: 'network mismatch' });
    });

    it('rejects invalid epoch and maximum block times', function () {
        assert.deepStrictEqual(rollcallSignersRequest(
            CONFIG, { epoch_height: -1, max_block_time: 10 }
        ), { error: 'invalid epoch_height' });
        assert.deepStrictEqual(rollcallSignersRequest(
            CONFIG, { epoch_height: 1, max_block_time: 'later' }
        ), { error: 'invalid max_block_time' });
    });

    it('rejects a key list above the read ceiling', function () {
        const pubkeys = Array(ROLLCALL_READ_MAX_KEYS + 1).fill(KEY);
        assert.deepStrictEqual(rollcallSignersRequest(
            CONFIG, { epoch_height: 1, max_block_time: 10, pubkeys }
        ), { error: 'too many keys requested' });
    });

    it('drops malformed keys and lowercases valid keys', function () {
        const request = rollcallSignersRequest(CONFIG, {
            network: 'regtest',
            epoch_height: '12',
            max_block_time: '34',
            pubkeys: [KEY, 'f'.repeat(63), 'g'.repeat(64)],
            publishers: [PUBLISHER, null, 'not-hex']
        });
        assert.deepStrictEqual(request, {
            epoch: 12,
            maxT: 34,
            keys: [KEY.toLowerCase()],
            pubs: [PUBLISHER.toLowerCase()]
        });
    });

    it('treats non-array key inputs as empty', function () {
        assert.deepStrictEqual(rollcallSignersRequest(CONFIG, {
            epoch_height: 12,
            max_block_time: 34,
            pubkeys: KEY,
            publishers: { publisher: PUBLISHER }
        }), { epoch: 12, maxT: 34, keys: [], pubs: [] });
    });
});

describe('rollcall presence mapping', function () {
    it('returns requested null entries without querying when the cut is null', async function () {
        const db = {
            getRollcallSignersForKeys: sinon.stub(),
            getRollcallPublishers: sinon.stub()
        };
        const keys = [KEY.toLowerCase(), OTHER_KEY.toLowerCase()];
        const pubs = [PUBLISHER.toLowerCase()];
        assert.deepStrictEqual(await rollcallPresence(db, 12, keys, pubs, null), {
            signers: {
                [KEY.toLowerCase()]: null,
                [OTHER_KEY.toLowerCase()]: null
            },
            publishersOut: { [PUBLISHER.toLowerCase()]: null }
        });
        assert.ok(db.getRollcallSignersForKeys.notCalled);
        assert.ok(db.getRollcallPublishers.notCalled);
    });

    it('normalizes signer and publisher rows when a cut exists', async function () {
        const signerRows = [{
            pubkey: KEY,
            sig: SIG,
            ledger_hash: LEDGER_HASH,
            publisher: PUBLISHER,
            action_index: '7',
            block_index: '8'
        }];
        const publisherRows = [{ publisher: PUBLISHER, action_index: '9', block_index: '10' }];
        const db = {
            getRollcallSignersForKeys: sinon.stub().resolves(signerRows),
            getRollcallPublishers: sinon.stub().resolves(publisherRows)
        };
        const keys = [KEY.toLowerCase()];
        const pubs = [PUBLISHER.toLowerCase()];
        const result = await rollcallPresence(db, 12, keys, pubs, 99);
        assert.deepStrictEqual(result, {
            signers: { [KEY.toLowerCase()]: {
                sig: SIG.toLowerCase(),
                ledger_hash: LEDGER_HASH.toLowerCase(),
                publisher: PUBLISHER.toLowerCase(),
                action_index: 7,
                block_index: 8,
                gates: null
            } },
            publishersOut: { [PUBLISHER.toLowerCase()]: {
                action_index: 9,
                block_index: 10
            } }
        });
        assert.ok(db.getRollcallSignersForKeys.calledOnceWithExactly(12, keys, 99));
        assert.ok(db.getRollcallPublishers.calledOnceWithExactly(12, pubs, 99));
    });
});
