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
// Contract meta: every verdict row of CONTRACT_META_REQUIRED driven through the real DEPLOY
// handler, plus the storage half (which META_* values reach createContract) and the
// below-flag-day half (today's verdicts, byte for byte, and the columns still filled
// for a conforming value). The grammar itself is unit-tested in
// test/unit/contract_meta_text.test.js.
// The verdict rows and the registration are in this file; precedence, function
// exports, storage and the below-flag-day half are in the parts under
// deploy_contract_meta.test/, and the shared fixtures in its helpers/meta_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer } = require('../../fixtures/mocks');
const { readOf, deployWith, metaArgs, freshMetaSuite } = require('./deploy_contract_meta.test/helpers/meta_suite.js');

const contractMeta = require('../../../src/actions/deploy/contract_meta.js');
const V            = contractMeta.VERDICTS;

// Every same-title block below runs this before each test, so each test
// starts from the same fixtures as the rest of the suite.
function freshSuite() {
    freshMetaSuite();
}

describe('DEPLOY meta verdicts (CONTRACT_META_REQUIRED) @regression @tier1', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('the seven verdict rows, at/after the flag day', function () {
        it('row 1: a module-level throw (success:false) is (manifest read failed), NOT a nameless valid', async function () {
            // The bypass this rule exists to close: below the flag day a throwing contract
            // deploys 'valid' because the whole verdict block sits inside success && manifest.
            const { status } = await deployWith({ success: false, manifest: null, error: 'ReferenceError: boom' });
            assert.strictEqual(status, V.READ_FAILED);
        });

        it('row 1: an unparseable report (manifest null) is (manifest read failed)', async function () {
            const { status } = await deployWith({ success: true, manifest: null, error: null });
            assert.strictEqual(status, V.READ_FAILED);
        });

        it('row 2: no meta export is (meta required)', async function () {
            const { status } = await deployWith(readOf(undefined));
            assert.strictEqual(status, V.REQUIRED);
        });

        it('row 3: meta null is (meta must be a plain object)', async function () {
            const { status } = await deployWith(readOf(null));
            assert.strictEqual(status, V.NOT_OBJECT);
        });

        it('row 3: meta as an array is (meta must be a plain object)', async function () {
            const { status } = await deployWith(readOf(['Escrow']));
            assert.strictEqual(status, V.NOT_OBJECT);
        });
    });
});

describe('DEPLOY meta verdicts (CONTRACT_META_REQUIRED) @regression @tier1', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('the seven verdict rows, at/after the flag day', function () {
        it('row 3: a Date serialises to a non-object and is (meta must be a plain object)', async function () {
            const read = readOf(new Date('2026-09-08T00:00:00Z'));
            assert.strictEqual(read.manifest.metaError, true, 'the wrapper mirror must flag a Date');
            const { status } = await deployWith(read);
            assert.strictEqual(status, V.NOT_OBJECT);
        });

        it('row 3: a circular meta cannot be serialised and is (meta must be a plain object)', async function () {
            const circular = { name: 'Escrow', description: 'Circular' };
            circular.self = circular;
            const read = readOf(circular);
            assert.strictEqual(read.manifest.metaError, true, 'the wrapper mirror must flag a circular meta');
            assert.strictEqual(read.manifest.metaJson, null);
            const { status } = await deployWith(read);
            assert.strictEqual(status, V.NOT_OBJECT);
        });

        it('row 4: a 5000-character meta is (meta exceeds 4096 characters)', async function () {
            const read = readOf({ name: 'Escrow', description: 'Big', filler: 'x'.repeat(5000) });
            assert.strictEqual(read.manifest.metaOversize, true);
            assert.ok(JSON.stringify({ name: 'Escrow', description: 'Big', filler: 'x'.repeat(5000) }).length > 5000);
            const { status } = await deployWith(read);
            assert.strictEqual(status, V.OVERSIZE);
        });

        it('row 5: a name carrying U+202E (bidi override) is the name string', async function () {
            const { status } = await deployWith(readOf({ name: 'Esc\u202Erow', description: 'Bidi' }));
            assert.strictEqual(status, V.NAME);
        });
    });
});

describe('DEPLOY meta verdicts (CONTRACT_META_REQUIRED) @regression @tier1', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('the seven verdict rows, at/after the flag day', function () {
        it('row 5: a name carrying a lone surrogate is the name string', async function () {
            const json = JSON.stringify({ name: 'Escrow\uD800', description: 'Lone surrogate' });
            assert.strictEqual(JSON.parse(json).name.isWellFormed(), false);
            const { status } = await deployWith(readOf(undefined, { metaType: 'object', metaJson: json }));
            assert.strictEqual(status, V.NAME);
        });

        it('row 5: a name with a leading U+00A0 is the name string (untrimmed, and trim() is never used)', async function () {
            const { status } = await deployWith(readOf({ name: '\u00A0Escrow', description: 'Leading NBSP' }));
            assert.strictEqual(status, V.NAME);
        });

        it('row 6: a description with a LEADING LF is the description string', async function () {
            const { status } = await deployWith(readOf({ name: 'Escrow', description: '\nLeading LF' }));
            assert.strictEqual(status, V.DESCRIPTION);
        });

        it('row 6: a description with an INTERIOR LF deploys valid and stores the bytes unchanged', async function () {
            const meta = { name: 'Escrow', description: 'line one\nline two', version: '1.0.0' };
            const { status, createContract } = await deployWith(readOf(meta));
            assert.strictEqual(status, 'valid');
            assert.strictEqual(metaArgs(createContract).META_DESCRIPTION, 'line one\nline two');
        });

        it("row 7: version '' is the version string", async function () {
            const { status } = await deployWith(readOf({ name: 'Escrow', description: 'Escrow', version: '' }));
            assert.strictEqual(status, V.VERSION);
        });

        it('row 7: version ABSENT deploys valid and stores a NULL meta_version', async function () {
            const { status, createContract } = await deployWith(readOf({ name: 'Escrow', description: 'Escrow' }));
            assert.strictEqual(status, 'valid');
            assert.strictEqual(metaArgs(createContract).META_VERSION, null);
            assert.strictEqual(metaArgs(createContract).META_NAME, 'Escrow');
        });

    });
});

describe('DEPLOY meta verdicts (CONTRACT_META_REQUIRED) @regression @tier1', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('registration', function () {

        it('CONTRACT_META_REQUIRED is registered, genesis-active on mainnet and regtest and armed on testnet at 2026-09-13T00:00:00Z', function () {
            const ProtocolChanges = require('../../../src/protocol_changes.js');
            const TESTNET_ARM = 1789257600; // 2026-09-13T00:00:00Z, pinned by the v0.17.0 cut
            assert.strictEqual(ProtocolChanges.CONTRACT_META_REQUIRED_MAINNET_TIME, 0);
            assert.strictEqual(ProtocolChanges.CONTRACT_META_REQUIRED_TESTNET_TIME, TESTNET_ARM);
            assert.strictEqual(TESTNET_ARM, Date.UTC(2026, 8, 13) / 1000,
                'the armed instant is 00:00:00Z of the second day after the carrying release lands');

            const pc = new ProtocolChanges(createMockIndexer(), '0.2.0');
            const change = pc.changes['CONTRACT_META_REQUIRED'];
            assert.ok(change, 'CONTRACT_META_REQUIRED must be registered');
            assert.strictEqual(change.mainnet_time, 0);
            assert.strictEqual(change.testnet_time, TESTNET_ARM);
            assert.strictEqual(change.regtest_time, 0);
            assert.strictEqual(change.mainnet_block, 0);
            assert.strictEqual(change.testnet_block, 0);
            assert.strictEqual(change.regtest_block, 0);
        });

    });
});
