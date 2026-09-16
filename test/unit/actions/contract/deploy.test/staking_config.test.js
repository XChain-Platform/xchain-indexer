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
// DEPLOY unit suite: FORMAT 1 staking config (COOLDOWN_BLOCKS and
// SLASH_DESTINATION). One part of deploy.test.js; the shared fixtures are in
// helpers/deploy_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { VALID_CODE_B64, SOURCE, deployData, freshDeploySuite } = require('./helpers/deploy_suite.js');

// The suite's fixtures. Every same-title block below runs freshSuite before
// each test, so each test starts from the same fixtures as the rest of the suite.
let indexer, actionsCtx, handler;
function freshSuite() {
    ({ indexer, actionsCtx, handler } = freshDeploySuite());
}

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── FORMAT 1: staking config (COOLDOWN_BLOCKS + SLASH_DESTINATION) ──

    describe('FORMAT 1: staking config', function () {
        it('valid v1 with COOLDOWN_BLOCKS sets STATUS valid', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '100', 'BURN'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('rejects SLASH_DESTINATION without COOLDOWN_BLOCKS', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '', '1SomeAddress'], data, null);
            assert.ok(String(data['STATUS']).includes('SLASH_DESTINATION'));
        });

        it('rejects non-numeric COOLDOWN_BLOCKS', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', 'abc', ''], data, null);
            assert.ok(String(data['STATUS']).includes('COOLDOWN_BLOCKS'));
        });
    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('FORMAT 1: staking config', function () {
        // isNumeric alone accepted fractional strings, storing a fractional
        // cooldown_blocks against the documented unsigned-int bound. The integer
        // gate is consensus-gated (COOLDOWN_BLOCKS_INTEGER, contract-era flag-day)
        // so a from-genesis replay reproduces any historic fractional accept.
        it('rejects fractional COOLDOWN_BLOCKS once COOLDOWN_BLOCKS_INTEGER is active', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '50.5', ''], data, null);
            assert.ok(String(data['STATUS']).includes('COOLDOWN_BLOCKS (not an integer)'));
        });

        it('accepts fractional COOLDOWN_BLOCKS below the COOLDOWN_BLOCKS_INTEGER flag-day (replay fidelity)', async function () {
            const isEnabled = sinon.stub().resolves(true);
            isEnabled.withArgs('COOLDOWN_BLOCKS_INTEGER', sinon.match.any).resolves(false);
            actionsCtx.protocolChanges.isEnabled = isEnabled;
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '50.5', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('rejects COOLDOWN_BLOCKS of 0 (out of range)', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '0', ''], data, null);
            assert.ok(String(data['STATUS']).includes('COOLDOWN_BLOCKS'));
        });

        it('rejects COOLDOWN_BLOCKS exceeding max', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '999999', ''], data, null);
            assert.ok(String(data['STATUS']).includes('COOLDOWN_BLOCKS'));
        });

        it('COOLDOWN_BLOCKS without SLASH_DESTINATION defaults to BURN address (line 107-109)', async function () {
            // hasCooldown=true, hasDest=false → SLASH_DESTINATION set to BURN address from config
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '100', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            // createContract should have been called (deploy succeeded)
            sinon.assert.calledOnce(indexer.indexerDb.createContract);
        });
    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('FORMAT 1: staking config', function () {
        // Pkg6 / dede7788 (gated DEPLOY_SLASH_DEST_ADDRESS_VALID): an explicit SLASH_DESTINATION
        // must resolve to a well-formed chain address, else it is interned into the immutable
        // contracts.slash_destination and every later slash routes stake to an unspendable address.
        it('accepts an explicit well-formed SLASH_DESTINATION', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '100', SOURCE], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('rejects a malformed explicit SLASH_DESTINATION once DEPLOY_SLASH_DEST_ADDRESS_VALID is active', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '100', '1SomeAddress'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: SLASH_DESTINATION (invalid address)');
        });

        it('rejects a dangling caret ^<id> SLASH_DESTINATION (resolveAddressRef leaves it unchanged)', async function () {
            // The mock resolveAddressRef returns the value unchanged, so a non-resolvable
            // ^<id> stays '^999' and isCryptoAddress rejects it (never reaches the slash FK).
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '100', '^999'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: SLASH_DESTINATION (invalid address)');
        });

        it('accepts a malformed explicit SLASH_DESTINATION below the DEPLOY_SLASH_DEST_ADDRESS_VALID flag-day (replay fidelity)', async function () {
            const isEnabled = sinon.stub().resolves(true);
            isEnabled.withArgs('DEPLOY_SLASH_DEST_ADDRESS_VALID', sinon.match.any).resolves(false);
            actionsCtx.protocolChanges.isEnabled = isEnabled;
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '100', '1SomeAddress'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('a dest-without-cooldown DEPLOY still reports requires COOLDOWN_BLOCKS (precedence preserved)', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '', '1SomeAddress'], data, null);
            assert.ok(String(data['STATUS']).includes('SLASH_DESTINATION (requires COOLDOWN_BLOCKS)'));
        });

    });
});
