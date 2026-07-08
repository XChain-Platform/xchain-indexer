/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Admin-method auth: JSON-RPC batch bypass regression.
 *
 * express-json-rpc-router dispatches every element of an array (batch) body,
 * so the API-key gate must inspect ALL elements, not just req.body.method
 * (which is undefined for an array). Regression: a one-element batch
 * [{"method":"pushvalidatorrewards"}] previously bypassed the key check
 * entirely, letting an unauthenticated caller forge spendable
 * validator_rewards rows / run the VM / enumerate the validator set.
 *
 * startApi() is not importable (it opens DB connections), so this mirrors the
 * middleware from src/api.js exactly and drives it with fake req/res, matching
 * the reconstruction pattern used by xchain-utxo-tracker's api unit test.
 *********************************************************************/

'use strict';

const assert = require('assert');

// Must match src/api.js.
const WRITE_METHODS = new Set(['pushvalidatorrewards']);
const GATED_EXEC_METHODS = new Set(['feequotedryrun']);
const FEDERATION_READ_METHODS = new Set([
    'getownstake', 'getactivevalidators', 'getactivestakeweights',
    'getcapabilityvalidators', 'getstakeweightsbycapability',
    'getstakesourcebypubkey', 'getfullnodeverifiers',
    'getpendingattestation_requests', 'getopencrosschainorders',
    'getactionconfirmations', 'getpendingcrosschaincalls',
    'getcrosschaincall', 'getcrosschaincallresult'
]);

// Exact copy of the guard in src/api.js (keep in sync).
function makeGuard(INDEXER_API_KEY, ALLOW_UNAUTHED) {
    return function (req, res, next) {
        let calls = Array.isArray(req.body) ? req.body : [req.body];
        let id = (Array.isArray(req.body) ? null : (req.body && req.body.id)) || null;
        let gated = calls.some(call => {
            let method = call && call.method;
            let normalized = method ? method.toLowerCase() : '';
            return method && (WRITE_METHODS.has(normalized) || FEDERATION_READ_METHODS.has(normalized) || GATED_EXEC_METHODS.has(normalized));
        });
        if (gated) {
            if (INDEXER_API_KEY) {
                let provided = req.headers['x-api-key'] || '';
                if (provided !== INDEXER_API_KEY) {
                    return res.status(401).json({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } });
                }
            } else if (!ALLOW_UNAUTHED) {
                return res.status(401).json({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } });
            }
        }
        next();
    };
}

// Minimal Express-style res double capturing status + json payload.
function fakeRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
    };
}

function run(guard, body, headers = {}) {
    const req = { body, headers };
    const res = fakeRes();
    let nextCalled = false;
    guard(req, res, () => { nextCalled = true; });
    return { res, nextCalled };
}

describe('indexer API auth: JSON-RPC batch gate', function () {
    describe('with INDEXER_API_KEY configured', function () {
        const guard = makeGuard('secret', false);

        it('401s a single gated call with no key', function () {
            const { res, nextCalled } = run(guard, { jsonrpc: '2.0', method: 'pushvalidatorrewards', id: 1 });
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(nextCalled, false);
        });

        it('401s a gated call smuggled inside a BATCH with no key', function () {
            const { res, nextCalled } = run(guard, [{ jsonrpc: '2.0', method: 'pushvalidatorrewards', id: 1 }]);
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(nextCalled, false);
        });

        it('401s a gated call mixed with a public call in a batch', function () {
            const { res, nextCalled } = run(guard, [
                { jsonrpc: '2.0', method: 'ping', id: 1 },
                { jsonrpc: '2.0', method: 'getactivevalidators', id: 2 }
            ]);
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(nextCalled, false);
        });

        it('passes a gated batch with the correct key', function () {
            const { res, nextCalled } = run(guard,
                [{ jsonrpc: '2.0', method: 'pushvalidatorrewards', id: 1 }],
                { 'x-api-key': 'secret' });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(nextCalled, true);
        });

        it('passes a public-only batch with no key', function () {
            const { res, nextCalled } = run(guard, [{ jsonrpc: '2.0', method: 'ping', id: 1 }]);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(nextCalled, true);
        });
    });

    describe('with no key and ALLOW_UNAUTHED=false (fail closed)', function () {
        const guard = makeGuard('', false);

        it('401s a gated batch', function () {
            const { res, nextCalled } = run(guard, [{ jsonrpc: '2.0', method: 'feequotedryrun', id: 1 }]);
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(nextCalled, false);
        });
    });

    describe('with no key and ALLOW_UNAUTHED=true (keyless escape hatch)', function () {
        const guard = makeGuard('', true);

        it('passes a gated batch (explicitly keyless)', function () {
            const { res, nextCalled } = run(guard, [{ jsonrpc: '2.0', method: 'feequotedryrun', id: 1 }]);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(nextCalled, true);
        });
    });
});
