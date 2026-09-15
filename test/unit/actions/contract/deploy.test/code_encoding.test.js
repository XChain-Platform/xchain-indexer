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
// DEPLOY unit suite: decoding CODE_ENCODING, and the activation gate that reads it
// as hex below and base64 at/above. One part of deploy.test.js; the shared
// fixtures are in helpers/deploy_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { VALID_CODE, VALID_CODE_B64, deployData, freshDeploySuite } = require('./helpers/deploy_suite.js');

// The suite's fixtures. Every same-title block below runs freshSuite before
// each test, so each test starts from the same fixtures as the rest of the suite.
let indexer, actionsCtx, handler;
function freshSuite() {
    ({ indexer, actionsCtx, handler } = freshDeploySuite());
}

const crypto = require('crypto');
const SOURCE_HASH = crypto.createHash('sha256').update(VALID_CODE).digest('hex');

// Run one inline DEPLOY with the gate forced on/off and return what was
// recorded: the final STATUS and the code_hash written to `contracts`.
async function runDeploy({ enabled, codeEncoding }) {
    actionsCtx.protocolChanges.isEnabled = sinon.stub().resolves(enabled);
    // Reset so this run's createContract is always firstCall, even when the
    // helper is invoked twice in one test (both-sides-of-the-gate cases).
    indexer.indexerDb.createContract.resetHistory();
    const data = deployData({ FORMAT: 0 });
    await handler.parse(['0', codeEncoding, '100000', ''], data, null);
    const codeHash = indexer.indexerDb.createContract.calledOnce
        ? indexer.indexerDb.createContract.firstCall.args[0].CODE_HASH
        : null;
    return { status: data['STATUS'], codeHash };
}

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── Hex decode failure (line 141-142) ───────────────────────────────

    describe('base64 decode failure', function () {

        it('rejects CODE_ENCODING that is not canonical base64', async function () {
            // Buffer.from(...,'base64') is lenient (silently drops chars outside the
            // alphabet), so the handler round-trips: decode then re-encode and compare.
            // A non-canonical string fails that check without needing a stub.
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', 'not-valid-base64!!', '100000', ''], data, null);

            assert.ok(String(data['STATUS']).includes('CODE_ENCODING'));
        });

    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── CODE_ENCODING activation gate (hex below, base64 at/above) ──────
    //
    // Inline DEPLOY decodes CODE_ENCODING as base64 at/after the
    // DEPLOY_BASE64_CODE activation and as hex before it. The gate exists so a
    // heterogeneous fleet and any from-genesis replay decode every historical
    // inline DEPLOY identically; an ungated flip silently re-reads every hex-era
    // DEPLOY as base64, changing its code_hash and forking the ledger. These tests
    // drive both sides of the gate by flipping the protocolChanges stub.

    describe('CODE_ENCODING activation gate', function () {
        const VALID_CODE_HEX = Buffer.from(VALID_CODE, 'utf8').toString('hex');

        it('at/above the gate decodes base64 → valid, code_hash = sha256(source)', async function () {
            const { status, codeHash } = await runDeploy({ enabled: true, codeEncoding: VALID_CODE_B64 });
            assert.strictEqual(status, 'valid');
            assert.strictEqual(codeHash, SOURCE_HASH);
        });

        it('below the gate decodes hex → valid, code_hash = sha256(source)', async function () {
            const { status, codeHash } = await runDeploy({ enabled: false, codeEncoding: VALID_CODE_HEX });
            assert.strictEqual(status, 'valid');
            assert.strictEqual(codeHash, SOURCE_HASH);
        });

        it('both correct encodings of the SAME source converge on one code_hash', async function () {
            const above = await runDeploy({ enabled: true,  codeEncoding: VALID_CODE_B64 });
            const below = await runDeploy({ enabled: false, codeEncoding: VALID_CODE_HEX });
            assert.strictEqual(above.codeHash, below.codeHash,
                'a hex-era and a base64-era DEPLOY of identical source must hash identically');
        });

        it('the SAME on-chain field forks across the gate (the bug the gate prevents)', async function () {
            // One byte-identical CODE_ENCODING value decoded on each side of the gate
            // must NOT yield the same contract (that divergence is precisely the
            // ledger fork. Feed the hex string: below the gate it decodes to the real
            // source; at/above it is (mis)read as base64 and yields a different result.
            const below = await runDeploy({ enabled: false, codeEncoding: VALID_CODE_HEX });
            const above = await runDeploy({ enabled: true,  codeEncoding: VALID_CODE_HEX });
            assert.strictEqual(below.status, 'valid');
            assert.strictEqual(below.codeHash, SOURCE_HASH);
            // Above the gate the same field is rejected or hashes to something else;
            // either way it does not reproduce the hex-era contract.
            const forked = (above.status !== 'valid') || (above.codeHash !== SOURCE_HASH);
            assert.ok(forked, 'reading the hex field as base64 must not reproduce the hex-era contract');
        });
    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('CODE_ENCODING activation gate', function () {
        it('a base64 field below the gate (read as hex) does not yield the base64-era contract', async function () {
            // Symmetric guard: the base64 string read as hex below the gate must not
            // silently reproduce the base64-era contract.
            const below = await runDeploy({ enabled: false, codeEncoding: VALID_CODE_B64 });
            const diverged = (below.status !== 'valid') || (below.codeHash !== SOURCE_HASH);
            assert.ok(diverged, 'reading the base64 field as hex must not reproduce the base64-era contract');
        });

    });
});
