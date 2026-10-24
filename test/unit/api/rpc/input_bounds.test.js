/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * API input boundaries shared by the JSON-RPC route families.
 */

'use strict';

const assert = require('assert');

const { buildRpcController } = require('../../../../src/api/rpc/index.js');
const { buildBetsRpc } = require('../../../../src/api/rpc/bets.js');
const { buildAttestationRpc } = require('../../../../src/api/rpc/attest/attestation.js');
const { buildSystemRpc } = require('../../../../src/api/rpc/system.js');
const { jsonRpcBatchGuard, JSON_RPC_MAX_BATCH } = require('../../../../src/api/middleware.js');
const { apiKeyGate } = require('../../../../src/api/auth_gate.js');
const betListings = require('../../../../src/db/bets/listings.js');
const { recordingView, fakeIndexer } = require('./helpers/fake_indexer.js');

function runMiddleware(middleware, body) {
    let passed = false;
    let status = null;
    let payload = null;
    const res = {
        status(value) { status = value; return this; },
        json(value) { payload = value; return this; }
    };
    middleware({ body }, res, () => { passed = true; });
    return { passed, status, payload };
}

describe('JSON-RPC input boundaries @regression @tier1', function () {
    it('bounds a batch before any element is dispatched', function () {
        const atLimit = Array.from({ length: JSON_RPC_MAX_BATCH }, (_, id) => ({ id, method: 'ping' }));
        assert.strictEqual(runMiddleware(jsonRpcBatchGuard, atLimit).passed, true);

        const overLimit = atLimit.concat({ id: JSON_RPC_MAX_BATCH, method: 'ping' });
        assert.deepStrictEqual(runMiddleware(jsonRpcBatchGuard, overLimit), {
            passed: false,
            status: 413,
            payload: {
                jsonrpc: '2.0',
                id: null,
                error: { code: -32600, message: 'Invalid Request: batch exceeds 100 elements' }
            }
        });
    });

    it('turns non-object params into a stable error without invoking a handler', async function () {
        const controller = buildRpcController({
            indexer: fakeIndexer(),
            liveness: { indexerRunning: true, indexerError: null },
            ENABLE_DRYRUN: false,
            rollcallManifestHash: () => null
        });
        assert.deepStrictEqual(await controller.getactivevalidators(null), { error: 'params must be an object' });
        assert.deepStrictEqual(await controller.getactivevalidators(['0']), { error: 'params must be an object' });
    });

    it('validates batch element parameters independently', async function () {
        const calls = [];
        const controller = buildRpcController({
            indexer: fakeIndexer(),
            liveness: { indexerRunning: true, indexerError: null },
            ENABLE_DRYRUN: false,
            rollcallManifestHash: () => null
        }, [() => ({
            async inputboundsprobe({ value }) {
                calls.push(value);
                return { value };
            }
        })]);
        assert.deepStrictEqual(await Promise.all([
            controller.inputboundsprobe({ value: 1 }),
            controller.inputboundsprobe(null),
            controller.inputboundsprobe({ value: 2 })
        ]), [
            { value: 1 },
            { error: 'params must be an object' },
            { value: 2 }
        ]);
        assert.deepStrictEqual(calls, [1, 2]);
    });

    it('passes a field the handler does not read through to the handler, so a newer caller is still served', async function () {
        const view = recordingView({ getLatestBlockIndex: 100, getActiveValidators: [] });
        const controller = buildRpcController({
            indexer: fakeIndexer({ view }),
            liveness: { indexerRunning: true, indexerError: null },
            ENABLE_DRYRUN: false,
            rollcallManifestHash: () => null
        });
        const result = await controller.getactivevalidators({ block_index: 5, field_added_by_a_newer_hub: true });
        assert.strictEqual(result.error, undefined);
        assert.ok(view.calls.some(call => call[0] === 'getActiveValidators'));
    });

    it('rejects exponent, negative, fractional and unsafe row indexes before a DB call', async function () {
        const view = recordingView({
            getBetFeedInfo: { id: 1 },
            getBetFeedPools: [],
            getLatestBlockIndex: 100,
            getActionInfo: null,
            getStoredBlockHashes: null
        });
        const indexer = fakeIndexer({ view, decoderView: recordingView({}) });
        const bets = buildBetsRpc({ indexer });
        const attest = buildAttestationRpc({ indexer });
        const system = buildSystemRpc({ indexer, liveness: {} });

        for (const value of ['1e2', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            assert.deepStrictEqual(await bets.getbetfeed({ action_index: value }),
                { error: 'action_index must be a positive integer' });
            assert.deepStrictEqual(await attest.getactionconfirmations({ action_index: value }),
                { error: 'action_index must be a positive integer' });
            assert.deepStrictEqual(await system.getblockhashes({ block_index: value }),
                { error: 'invalid block_index' });
        }
        assert.deepStrictEqual(view.calls, []);
    });

    it('rejects malformed limits and incomplete cursors instead of silently changing the query', async function () {
        const view = recordingView({ getLatestBlockIndex: 70, getPendingAttestationRequests: [] });
        const rpc = buildAttestationRpc({ indexer: fakeIndexer({ view }) });
        for (const limit of ['1e2', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            assert.deepStrictEqual(await rpc.getpendingattestation_requests({ limit }),
                { error: 'limit must be a positive integer' });
        }
        assert.deepStrictEqual(await rpc.getpendingattestation_requests({ after_block_index: 4 }),
            { error: 'after_block_index and after_action_index must be supplied together' });
        assert.deepStrictEqual(view.calls, []);
    });

    it('binds betting list limits as SQL parameters', async function () {
        const queries = [];
        const db = {
            util: {
                isNull: value => value === null || value === undefined,
                isNumeric: value => Number.isFinite(Number(value))
            },
            async doQuery(sql, args) { queries.push({ sql, args }); return []; }
        };
        await betListings.getBetFeedRows.call(db, { limit: 12 });
        await betListings.getBetRows.call(db, { limit: 13 });
        assert.strictEqual(queries.length, 2);
        assert.ok(queries.every(query => /LIMIT \?$/.test(query.sql.trim())));
        assert.match(queries[0].sql, /ORDER BY f\.action_index ASC\s+LIMIT \?/);
        assert.match(queries[1].sql, /ORDER BY b\.action_index ASC\s+LIMIT \?/);
        assert.deepStrictEqual(queries.map(query => query.args.at(-1)), [12, 13]);
    });

    it('opens keyless gated methods only for the boolean true escape hatch', function () {
        const base = {
            INDEXER_API_KEY: '',
            WRITE_METHODS: new Set(),
            FEDERATION_READ_METHODS: new Set(['getactivevalidators']),
            GATED_EXEC_METHODS: new Set()
        };
        assert.strictEqual(runMiddleware(apiKeyGate({ ...base, ALLOW_UNAUTHED: 'true' }),
            { method: 'getactivevalidators' }).status, 401);
        assert.strictEqual(runMiddleware(apiKeyGate({ ...base, ALLOW_UNAUTHED: true }),
            { method: 'getactivevalidators' }).passed, true);
    });

    it('treats non-string method names as malformed without crashing the auth gate', function () {
        const gate = apiKeyGate({
            INDEXER_API_KEY: 'secret',
            ALLOW_UNAUTHED: false,
            WRITE_METHODS: new Set(),
            FEDERATION_READ_METHODS: new Set(['getactivevalidators']),
            GATED_EXEC_METHODS: new Set()
        });
        assert.deepStrictEqual(runMiddleware(gate, { method: 12345 }), {
            passed: true,
            status: null,
            payload: null
        });
    });
});
