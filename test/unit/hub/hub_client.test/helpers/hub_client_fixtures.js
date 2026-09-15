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
// What the HubClient suite shares (hub_client.test.js plus the files in
// hub_client.test/): the fake http(s).request builder and the afterEach every
// describe('HubClient') block registers.

const sinon        = require('sinon');
const EventEmitter = require('events');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake http(s).request stub that invokes the response callback with a
 * simulated IncomingMessage, then drives 'data'+'end' events to deliver the body.
 *
 * Returns { stub, fakeReq } so tests can inspect calls and emit errors.
 */
function buildHttpStub(responseBody){
    let fakeReq = new EventEmitter();
    fakeReq.write = sinon.stub();
    fakeReq.end   = sinon.stub();
    fakeReq.destroy = sinon.stub().callsFake(function(err){ fakeReq.emit('error', err); });

    let stub = sinon.stub().callsFake(function(opts, cb){
        // Schedule the response asynchronously to let req.write/end fire first
        setImmediate(() => {
            let fakeRes = new EventEmitter();
            cb(fakeRes);
            setImmediate(() => {
                fakeRes.emit('data', responseBody);
                fakeRes.emit('end');
            });
        });
        return fakeReq;
    });
    return { stub, fakeReq };
}

/**
 * The suite's afterEach: undo every sinon stub and clear the hub endpoint env
 * vars a case may have set, so neither leaks into the next case.
 */
function restoreStubsAndHubEnv(){
    sinon.restore();
    // Remove env vars that could bleed between tests
    delete process.env.HUB_API_URL;
    delete process.env.HUB_API_KEY;
    delete process.env.HUB_CONFIG_URL;
    delete process.env.HUB_CONFIG_API_KEY;
}

module.exports = { buildHttpStub, restoreStubsAndHubEnv };
