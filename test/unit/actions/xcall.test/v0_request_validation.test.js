// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// XCALL v0 request field validation: the host-side re-checks and the
// per-field rejection paths. Part of the XCALL suite; see ../xcall.test.js,
// whose describe title each block here repeats so every full test title is
// unchanged.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { freshXcall, v0Data, v0Params, goodCallId } = require('./helpers/xcall_fixtures.js');

let indexer, handler;

function freshHandler() {
    ({ indexer, handler } = freshXcall());
}

function restoreStubs() {
    sinon.restore();
}

describe('Xcall (XCALL) @regression @tier3', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('v0: request', function () {
        it('re-validates gasLimit, hops, deadline and params host-side', async function () {
            for (const [overrides, re] of [
                [{ gasLimit: '4999' },   /GAS_LIMIT/],
                [{ gasLimit: '200001' }, /GAS_LIMIT/],
                [{ hops: '3' },          /CROSS_HOPS/],
                [{ hops: '0' },          /CROSS_HOPS/],
                [{ deadline: '5' },      /DEADLINE_BLOCKS/],
                [{ deadline: '4001' },   /DEADLINE_BLOCKS/],
                [{ paramsJson: 'nope' }, /PARAMS_JSON/],
            ]) {
                const data = v0Data();
                await handler.parse(v0Params(goodCallId(data), overrides), data, null);
                assert.match(data['STATUS'], re, JSON.stringify(overrides));
            }
        });

        it('rejects an unknown emitter contract', async function () {
            indexer.indexerDb.getContract.resolves(null);
            const data = v0Data();
            await handler.parse(v0Params(goodCallId(data)), data, null);
            assert.match(data['STATUS'], /CONTRACT_INDEX \(unknown\)/);
        });
    });
});

// ── Input-validation rejection paths (pre-quorum; no stake-weighted branch) ──
// Validation is sequential (first error wins), so each case keeps every earlier
// field valid and trips exactly one rule. A valid-format CALL_ID ('a'×64) is used
// where the rejection fires before the derivation check (which never runs then).

describe('Xcall (XCALL) @regression @tier3', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('v0: request', function () {
        it('rejects a CALL_ID that is not 64-hex (format)', async function () {
            const data = v0Data();
            await handler.parse(v0Params('not-a-valid-call-id'), data, null);
            assert.match(data['STATUS'], /CALL_ID \(format\)/);
        });

        it('rejects a TARGET_CHAIN outside the allow-list', async function () {
            const data = v0Data();
            await handler.parse(v0Params('a'.repeat(64), { targetChain: 'ETH' }), data, null);
            assert.match(data['STATUS'], /TARGET_CHAIN \(unknown\)/);
        });

        it('rejects a non-positive TARGET_CONTRACT_INDEX', async function () {
            for (const idx of ['0', '-1']) {
                const data = v0Data();
                await handler.parse(v0Params('a'.repeat(64), { targetIdx: idx }), data, null);
                assert.match(data['STATUS'], /TARGET_CONTRACT_INDEX/, 'idx=' + idx);
            }
        });

        it('rejects a missing METHOD', async function () {
            const data = v0Data();
            await handler.parse(v0Params(goodCallId(data), { method: null }), data, null);
            assert.match(data['STATUS'], /METHOD \(required\)/);
        });
    });
});

describe('Xcall (XCALL) @regression @tier3', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('v0: request', function () {
        it('rejects a METHOD longer than 64 bytes', async function () {
            const data = v0Data();
            await handler.parse(v0Params(goodCallId(data), { method: 'm'.repeat(65) }), data, null);
            assert.match(data['STATUS'], /METHOD \(too long\)/);
        });

        it('rejects a missing CALLBACK_METHOD', async function () {
            const data = v0Data();
            await handler.parse(v0Params(goodCallId(data), { cb: null }), data, null);
            assert.match(data['STATUS'], /CALLBACK_METHOD \(required\)/);
        });

        it('rejects a CALLBACK_METHOD longer than 64 bytes', async function () {
            const data = v0Data();
            await handler.parse(v0Params(goodCallId(data), { cb: 'c'.repeat(65) }), data, null);
            assert.match(data['STATUS'], /CALLBACK_METHOD \(too long\)/);
        });

        it('rejects PARAMS_JSON with more than 32 entries', async function () {
            const data = v0Data();
            await handler.parse(v0Params('a'.repeat(64), { paramsJson: JSON.stringify(Array(33).fill('x')) }), data, null);
            assert.match(data['STATUS'], /PARAMS_JSON/);
        });
    });
});

describe('Xcall (XCALL) @regression @tier3', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('v0: request', function () {
        it('rejects a PARAMS_JSON entry larger than 1024 bytes', async function () {
            const data = v0Data();
            await handler.parse(v0Params('a'.repeat(64), { paramsJson: JSON.stringify(['x'.repeat(1025)]) }), data, null);
            assert.match(data['STATUS'], /PARAMS_JSON/);
        });

        it('hard-fails when the emitter (CONTRACT_INDEX) is absent', async function () {
            const data = v0Data({ EMITTER: undefined });
            await handler.parse(v0Params('a'.repeat(64)), data, null);
            assert.match(data['STATUS'], /CONTRACT_INDEX \(missing emitter\)/);
        });

        it('hard-fails when TX_HASH is missing (no silent derivation bypass)', async function () {
            const data = v0Data({ TX_HASH: undefined });
            await handler.parse(v0Params('a'.repeat(64)), data, null);
            assert.match(data['STATUS'], /TX_HASH/);
        });
    });
});
