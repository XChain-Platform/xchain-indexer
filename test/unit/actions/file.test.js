// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const File = require('../../../src/actions/file.js');

describe('File action handler @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config: indexer.config,
            util: indexer.util,
            mapper: indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
        handler = new File(actionsCtx);
        indexer.util.resetLists();
    });

    // ─── Valid file creation ──────────────────────────────────────────

    it('creates a valid file record', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', 'Test File', 'a memo'];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('creates a valid file with no memo', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'logo.jpg', 'image/jpeg', 'Logo', ''];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects unknown format version', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 99 });
        const params = ['99', 'test.txt', 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('VERSION'), `Expected VERSION error, got: ${data['STATUS']}`);
    });

    // ─── NAME length limit ────────────────────────────────────────────

    it('rejects NAME exceeding MAX_FILE_NAME_LENGTH', async function () {
        const longName = 'n'.repeat(indexer.config['MAX_FILE_NAME_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', longName, 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('NAME'), `Expected NAME length error, got: ${data['STATUS']}`);
    });

    // ─── TYPE length limit ────────────────────────────────────────────

    it('rejects TYPE exceeding MAX_FILE_TYPE_LENGTH', async function () {
        const longType = 't'.repeat(indexer.config['MAX_FILE_TYPE_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.bin', longType, 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('TYPE'), `Expected TYPE length error, got: ${data['STATUS']}`);
    });

    // ─── TITLE length limit ───────────────────────────────────────────

    it('rejects TITLE exceeding MAX_FILE_TITLE_LENGTH', async function () {
        const longTitle = 'T'.repeat(indexer.config['MAX_FILE_TITLE_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', longTitle, ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('TITLE'), `Expected TITLE length error, got: ${data['STATUS']}`);
    });

    // ─── SOURCE sleeping check ────────────────────────────────────────

    it('rejects when SOURCE is sleeping', async function () {
        indexer.indexerDb.isActionAllowed.resolves(false);
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('SOURCE'), `Expected SOURCE sleeping error, got: ${data['STATUS']}`);
    });

    // ─── Side-effect checks ───────────────────────────────────────────

    it('calls createFile on the indexerDb', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(indexer.indexerDb.createFile.calledOnce);
    });

    it('calls mapper.createMappings after parse', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });

    // ─── Gated content validations ────────────────────────────────────────────

    describe('gated content', function () {
        const SOURCE     = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';
        const VALID_HASH = 'a'.repeat(64); // 64-char hex

        function makeGatedParams(overrides = {}) {
            return [
                '0',
                overrides.name  || 'secret.enc',
                overrides.type  || 'application/octet-stream',
                overrides.title || 'Gated File',
                overrides.memo  || '',
                overrides.gateTicker     || 'TEST',
                overrides.encMethod      !== undefined ? String(overrides.encMethod) : '1',
                overrides.keyHash        || VALID_HASH,
            ];
        }

        beforeEach(function () {
            // Extra stubs needed for gated file paths
            indexer.indexerDb.createGatedFile = sinon.stub().resolves();

            // Default: token found and owned by SOURCE
            const { createTokenInfo } = require('../../fixtures/mocks');
            indexer.indexerDb.getTokenInfo.resolves(
                createTokenInfo({ TICK: 'TEST', TICK_ID: 1, OWNER: SOURCE })
            );
            indexer.indexerDb.isOwnershipEscrowed.resolves(false);
        });

        it('valid gated file → STATUS valid, createGatedFile called', async function () {
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams(), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createFile.calledOnce);
            assert.ok(indexer.indexerDb.createGatedFile.calledOnce);
        });

        it('ENCRYPTION_METHOD != 1 → invalid', async function () {
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams({ encMethod: 2 }), data, null);
            assert.ok(data['STATUS'].includes('ENCRYPTION_METHOD'));
        });

        it('KEY_HASH wrong format (not 64-char hex) → invalid', async function () {
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams({ keyHash: 'tooshort' }), data, null);
            assert.ok(data['STATUS'].includes('KEY_HASH'));
        });

        it('KEY_HASH non-hex characters → invalid', async function () {
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams({ keyHash: 'z'.repeat(64) }), data, null);
            assert.ok(data['STATUS'].includes('KEY_HASH'));
        });

        it('GATE_TICKER not found → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams(), data, null);
            assert.ok(data['STATUS'].includes('GATE_TICKER'));
        });

        it('caller is not GATE_TICKER issuer → invalid', async function () {
            const { createTokenInfo } = require('../../fixtures/mocks');
            // Token owned by a different address
            indexer.indexerDb.getTokenInfo.resolves(
                createTokenInfo({ TICK: 'TEST', TICK_ID: 1, OWNER: '1OtherAddressXXXXXXXXXXXXXXXXVtKwXp' })
            );
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams(), data, null);
            assert.ok(data['STATUS'].includes('not GATE_TICKER issuer'));
        });

        it('GATE_TICKER ownership escrowed → invalid', async function () {
            indexer.indexerDb.isOwnershipEscrowed.resolves(true);
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams(), data, null);
            assert.ok(data['STATUS'].includes('ownership escrowed'));
        });

        it('createGatedFile NOT called on invalid gated file', async function () {
            // Missing GATE_TICKER token
            indexer.indexerDb.getTokenInfo.resolves(null);
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams(), data, null);
            assert.ok(!indexer.indexerDb.createGatedFile.called);
        });

        it('MEMO with pipe in gated file → invalid (basic MEMO check)', async function () {
            const data = createBaseData({ ACTION: 'FILE', FORMAT: 0, SOURCE });
            await handler.parse(makeGatedParams({ memo: 'bad|memo' }), data, null);
            assert.ok(data['STATUS'].includes('MEMO'));
        });
    });
});
