'use strict';

// Regression test for the Express 5 / body-parser 2.x JSON-RPC crash.
//
// After the express ^4 -> ^5 upgrade (which pulls in body-parser 2.x), a request
// that reaches the root-mounted express-json-rpc-router without a parsed JSON body
// (a GET health probe, an empty POST, or a POST with a non-JSON Content-Type) has
// req.body === undefined. The router then throws "req.body is required", which with
// no error handler surfaces as an HTTP 500 + stack trace. src/api.js normalizes
// req.body to {} just before the router to restore the body-parser 1.x behavior.
//
// This reconstructs the exact middleware chain using THIS service's own dependency
// versions, proves the regression exists without the guard, and proves the guard
// fixes it. It also asserts src/api.js still wires the guard before the router so
// the fix cannot silently regress.

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const jsonRouter = require('express-json-rpc-router');

const GUARD = (req, res, next) => { if (req.body === undefined) req.body = {}; next(); };
const METHODS = { ping: () => 'pong' };

function buildApp(withGuard) {
    const app = express();
    app.use(bodyParser.json());
    if (withGuard) app.use(GUARD);
    app.use(jsonRouter({ methods: METHODS }));
    // Silence Express's default error-handler stack dump so the control case
    // (unguarded -> 500) doesn't spew to stderr; the 500 status is what we assert.
    app.use((err, req, res, next) => { res.status(500).json({ error: 'internal' }); }); // eslint-disable-line no-unused-vars
    return app;
}

async function request(app, { method = 'GET', headers = {}, body } = {}) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { method, headers, body });
        return { status: res.status, text: await res.text() };
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

describe('JSON-RPC body guard (Express 5 / body-parser 2.x regression)', function () {
    this.timeout(10000);

    it('reproduces the crash WITHOUT the guard (bodiless GET -> 500)', async () => {
        const r = await request(buildApp(false), { method: 'GET' });
        assert.strictEqual(r.status, 500, 'expected the unguarded router to 500 on a bodiless GET');
    });

    it('does not crash WITH the guard (GET -> not 500)', async () => {
        const r = await request(buildApp(true), { method: 'GET' });
        assert.notStrictEqual(r.status, 500, `guarded GET should not 500 (got ${r.status})`);
    });

    it('does not crash WITH the guard on an empty POST (-> not 500)', async () => {
        const r = await request(buildApp(true), { method: 'POST' });
        assert.notStrictEqual(r.status, 500, `guarded empty POST should not 500 (got ${r.status})`);
    });

    it('still serves a valid JSON-RPC POST WITH the guard', async () => {
        const r = await request(buildApp(true), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(JSON.parse(r.text).result, 'pong');
    });

    it('src/api.js wires the guard before the jsonRouter mount', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
        const guardIdx = src.indexOf('if (req.body === undefined) req.body = {}');
        const routerIdx = src.indexOf('jsonRouter(');
        assert.notStrictEqual(guardIdx, -1, 'req.body guard missing from src/api.js');
        assert.notStrictEqual(routerIdx, -1, 'jsonRouter mount missing from src/api.js');
        assert.ok(guardIdx < routerIdx, 'guard must be registered before the jsonRouter mount');
    });
});
