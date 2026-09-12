'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Boundary coverage for src/UtxoTracker.js: the JSON-RPC client whose
// get_first_seen height feeds the DISPENSER fresh-address exception. The client
// gates its return on `typeof height === 'number'` ONLY (no range/integer/
// finiteness check), so these cases pin exactly where the numeric edge is drawn
// — zero, negative, fractional, NaN/Infinity, MAX_SAFE_INTEGER — plus the
// malformed-but-plausible address inputs it forwards verbatim and the
// enabled/disabled endpoint boundary in the constructor.
//
// The non-number cases have TWO sides since the oracle-shape flag-day: below it
// they collapse to null (the deployed, replay-frozen fail-open), at/after it they
// throw so the fresh-address verdict fails closed. Both are pinned here, and they
// flip with the same pins in the unit and regression suites.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert      = require('assert');
const sinon       = require('sinon');
const UtxoTracker = require('../../src/UtxoTracker.js');

// Stub global.fetch with a resolved JSON-RPC envelope. `ok`/`status` default to
// a 200 success; pass overrides to exercise the HTTP-error path.
function makeFetch(body, opts) {
    opts = opts || {};
    return sinon.stub().resolves({
        ok:     opts.ok !== undefined ? opts.ok : true,
        status: opts.status || 200,
        json:   async () => body,
    });
}

function rpc(result) {
    return { jsonrpc: '2.0', id: 1, result };
}

describe('UtxoTracker boundary tests @regression @tier1', function () {

    let origFetch;

    beforeEach(function () {
        origFetch = global.fetch;
    });

    afterEach(function () {
        global.fetch = origFetch;
        sinon.restore();
    });

    // -----------------------------------------------------------------------
    // UTX-B01: minimum valid height (genesis, block 0)
    // -----------------------------------------------------------------------
    describe('UTX-B01: height 0 (genesis)', function () {
        it('height 0 is a valid number and is returned, not treated as absent', async function () {
            const t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch(rpc({ height: 0 }));

            const r = await t.getFirstSeen('genesis');
            assert.deepStrictEqual(r, { height: 0 });
        });
    });

    // -----------------------------------------------------------------------
    // UTX-B02: negative height is forwarded (no non-negativity guard)
    // -----------------------------------------------------------------------
    describe('UTX-B02: negative height', function () {
        it('a negative height passes the numeric guard and is returned verbatim', async function () {
            const t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch(rpc({ height: -1 }));

            const r = await t.getFirstSeen('addr');
            assert.deepStrictEqual(r, { height: -1 });
        });
    });

    // -----------------------------------------------------------------------
    // UTX-B03: fractional / non-integer height is forwarded (no integer guard)
    // -----------------------------------------------------------------------
    describe('UTX-B03: fractional height', function () {
        it('a non-integer height is a number and is returned unrounded', async function () {
            const t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch(rpc({ height: 750000.5 }));

            const r = await t.getFirstSeen('addr');
            assert.deepStrictEqual(r, { height: 750000.5 });
        });
    });

    // -----------------------------------------------------------------------
    // UTX-B04 / UTX-B05: NaN and Infinity satisfy `typeof === 'number'`
    // -----------------------------------------------------------------------
    describe('UTX-B04: NaN height', function () {
        it('NaN is typeof "number" and is NOT filtered out', async function () {
            const t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch(rpc({ height: NaN }));

            const r = await t.getFirstSeen('addr');
            // deepStrictEqual treats NaN as equal to NaN.
            assert.deepStrictEqual(r, { height: NaN });
        });
    });

    describe('UTX-B05: Infinity height', function () {
        it('Infinity is typeof "number" and is returned verbatim', async function () {
            const t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch(rpc({ height: Infinity }));

            const r = await t.getFirstSeen('addr');
            assert.deepStrictEqual(r, { height: Infinity });
        });
    });

    // -----------------------------------------------------------------------
    // UTX-B06: very large heights (MAX_SAFE_INTEGER and beyond)
    // -----------------------------------------------------------------------
    describe('UTX-B06: extreme large heights', function () {
        it('MAX_SAFE_INTEGER is returned verbatim', async function () {
            const t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch(rpc({ height: Number.MAX_SAFE_INTEGER }));

            const r = await t.getFirstSeen('addr');
            assert.deepStrictEqual(r, { height: Number.MAX_SAFE_INTEGER });
        });

        it('a value beyond MAX_SAFE_INTEGER is still a number and returned (precision boundary)', async function () {
            const t = new UtxoTracker('localhost', 3005);
            const beyond = Number.MAX_SAFE_INTEGER + 1;
            global.fetch = makeFetch(rpc({ height: beyond }));

            const r = await t.getFirstSeen('addr');
            assert.deepStrictEqual(r, { height: beyond });
        });
    });

    // -----------------------------------------------------------------------
    // UTX-B07: non-number heights collapse to null
    // -----------------------------------------------------------------------
    describe('UTX-B07: non-number height → null', function () {
        const cases = [
            ['numeric string', '100'],
            ['boolean',        true],
            ['null',           null],
            ['nested object',  { value: 100 }],
        ];
        for (const [label, height] of cases) {
            it(`${label} height is rejected → null`, async function () {
                const t = new UtxoTracker('localhost', 3005);
                global.fetch = makeFetch(rpc({ height }));

                const r = await t.getFirstSeen('addr');
                assert.strictEqual(r, null);
            });
        }

        it('a result missing the height field → null', async function () {
            const t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch(rpc({ other: 'field' }));

            const r = await t.getFirstSeen('addr');
            assert.strictEqual(r, null);
        });
    });

    // -----------------------------------------------------------------------
    // UTX-B07b: the same non-number heights THROW at/after the oracle-shape
    // flag-day (src/dispenser_freshness_shape_activation.js). The null above is
    // fail-open into a consensus-relevant fresh-address verdict, so the edge moves
    // only behind the gate, and the numeric edge drawn in B01-B06 does not move at
    // all: those values already fail closed in the caller's height comparison.
    // -----------------------------------------------------------------------
    describe('UTX-B07b: non-number height → throw under strictShape', function () {
        const cases = [
            ['numeric string', '100'],
            ['boolean',        true],
            ['null',           null],
            ['nested object',  { value: 100 }],
        ];
        for (const [label, height] of cases) {
            it(`${label} height is a shape violation, not a fresh address`, async function () {
                const t = new UtxoTracker('localhost', 3005);
                global.fetch = makeFetch(rpc({ height }));

                await assert.rejects(
                    () => t.getFirstSeen('addr', { strictShape: true }),
                    /UTXO tracker shape violation/,
                );
            });
        }

        it('a result missing the height field is a shape violation', async function () {
            const t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch(rpc({ other: 'field' }));

            await assert.rejects(
                () => t.getFirstSeen('addr', { strictShape: true }),
                /UTXO tracker shape violation/,
            );
        });

        it('the numeric edge is unmoved: 0, negative, fractional, NaN and Infinity still pass', async function () {
            const t = new UtxoTracker('localhost', 3005);
            for (const height of [0, -1, 750000.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
                global.fetch = makeFetch(rpc({ height }));
                const r = await t.getFirstSeen('addr', { strictShape: true });
                assert.deepStrictEqual(r, { height });
            }
        });

        it('an absent result (never seen) is unmoved: still null, never a throw', async function () {
            const t = new UtxoTracker('localhost', 3005);
            global.fetch = makeFetch(rpc(null));
            assert.strictEqual(await t.getFirstSeen('never', { strictShape: true }), null);
        });
    });

    // -----------------------------------------------------------------------
    // UTX-B08: malformed-but-plausible address inputs are forwarded verbatim
    // -----------------------------------------------------------------------
    describe('UTX-B08: edge address inputs forwarded verbatim', function () {
        it('an empty-string address is passed straight through in params', async function () {
            const t = new UtxoTracker('localhost', 3005);
            const stub = makeFetch(rpc({ height: 1 }));
            global.fetch = stub;

            await t.getFirstSeen('');
            const sent = JSON.parse(stub.firstCall.args[1].body);
            assert.deepStrictEqual(sent.params, { address: '' });
        });

        it('an oversized (10k-char) address is forwarded without truncation', async function () {
            const t = new UtxoTracker('localhost', 3005);
            const stub = makeFetch(rpc({ height: 1 }));
            global.fetch = stub;

            const huge = 'x'.repeat(10000);
            await t.getFirstSeen(huge);
            const sent = JSON.parse(stub.firstCall.args[1].body);
            assert.strictEqual(sent.params.address.length, 10000);
            assert.strictEqual(sent.params.address, huge);
        });
    });

    // -----------------------------------------------------------------------
    // UTX-B09: constructor enabled/disabled boundary on the port value
    // -----------------------------------------------------------------------
    describe('UTX-B09: constructor port boundary', function () {
        it('port 0 is falsy → client disabled, endpoint null, _call throws', async function () {
            const t = new UtxoTracker('localhost', 0);
            assert.strictEqual(t.enabled, false);
            assert.strictEqual(t.endpoint, null);
            await assert.rejects(
                () => t.getFirstSeen('addr'),
                /UTXO tracker not configured/,
            );
        });

        it('a numeric-string port is truthy → client enabled, endpoint built', function () {
            const t = new UtxoTracker('localhost', '3005');
            assert.strictEqual(t.enabled, true);
            assert.strictEqual(t.endpoint, 'http://localhost:3005');
        });
    });
});
