// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Message = require('../../../src/actions/message.js');

// A valid BTC-format destination address (P2PKH on mainnet; util.isCryptoAddress accepts it)
const VALID_DEST = 'mqmJDcs5nXFHrj9q7a2G5sBVmjcQTDdUZp';

describe('Message action handler @regression @tier3', function () {
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
        handler = new Message(actionsCtx);
        indexer.util.resetLists();
    });

    // ─── Valid formats ────────────────────────────────────────────────

    it('accepts format 0 (sender key exchange)', async function () {
        const data = createBaseData({ ACTION: 'MESSAGE', FORMAT: 0 });
        const params = ['0', 'BTC', VALID_DEST, '1', 'MYPUBLICKEY'];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('accepts format 1 (receiver key exchange)', async function () {
        const data = createBaseData({ ACTION: 'MESSAGE', FORMAT: 1 });
        const params = ['1', 'BTC', VALID_DEST, '1', 'MYPUBLICKEY'];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('accepts format 2 (encrypted message)', async function () {
        const data = createBaseData({ ACTION: 'MESSAGE', FORMAT: 2 });
        const params = ['2', 'BTC', VALID_DEST, 'ENCRYPTEDPAYLOAD'];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        // v2 carries no ENCRYPTION_METHOD on the wire; absence implies ECIES (1),
        // so the handler must stamp 1 rather than persist null.
        assert.strictEqual(Number(data['ENCRYPTION_METHOD']), 1);
    });

    it('accepts format 3 (plaintext message)', async function () {
        const data = createBaseData({ ACTION: 'MESSAGE', FORMAT: 3 });
        const params = ['3', 'BTC', VALID_DEST, 'Hello there!'];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects unknown format version', async function () {
        const data = createBaseData({ ACTION: 'MESSAGE', FORMAT: 99 });
        const params = ['99', 'BTC', VALID_DEST, '1', 'key'];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('VERSION'), `Expected VERSION error, got: ${data['STATUS']}`);
    });

    // ─── ENCRYPTION_METHOD validation ────────────────────────────────

    it('accepts ENCRYPTION_METHOD=1 (ECDH)', async function () {
        const data = createBaseData({ ACTION: 'MESSAGE', FORMAT: 0 });
        const params = ['0', 'BTC', VALID_DEST, '1', 'key'];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('accepts ENCRYPTION_METHOD=2 (AES)', async function () {
        const data = createBaseData({ ACTION: 'MESSAGE', FORMAT: 0 });
        const params = ['0', 'BTC', VALID_DEST, '2', 'key'];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects ENCRYPTION_METHOD=99 (unsupported)', async function () {
        const data = createBaseData({ ACTION: 'MESSAGE', FORMAT: 0 });
        const params = ['0', 'BTC', VALID_DEST, '99', 'key'];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('ENCRYPTION_METHOD'), `Expected ENCRYPTION_METHOD error, got: ${data['STATUS']}`);
    });

    it('rejects non-numeric ENCRYPTION_METHOD', async function () {
        const data = createBaseData({ ACTION: 'MESSAGE', FORMAT: 0 });
        const params = ['0', 'BTC', VALID_DEST, 'ecdh', 'key'];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('ENCRYPTION_METHOD'), `Expected ENCRYPTION_METHOD format error, got: ${data['STATUS']}`);
    });

    // ─── Key length limit ─────────────────────────────────────────────

    it('rejects ENCRYPTION_KEY exceeding MAX_MESSAGE_KEY_LENGTH', async function () {
        const longKey = 'k'.repeat(indexer.config['MAX_MESSAGE_KEY_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'MESSAGE', FORMAT: 0 });
        const params = ['0', 'BTC', VALID_DEST, '1', longKey];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('ENCRYPTION_KEY'), `Expected ENCRYPTION_KEY error, got: ${data['STATUS']}`);
    });

    // ─── DESTINATION validation ───────────────────────────────────────

    it('rejects invalid DESTINATION address format', async function () {
        const data = createBaseData({ ACTION: 'MESSAGE', FORMAT: 3 });
        const params = ['3', 'BTC', 'not-an-address', 'hello'];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('DESTINATION'), `Expected DESTINATION error, got: ${data['STATUS']}`);
    });

    // ─── SOURCE sleeping check ────────────────────────────────────────

    it('rejects when SOURCE is sleeping', async function () {
        indexer.indexerDb.isActionAllowed.resolves(false);
        const data = createBaseData({ ACTION: 'MESSAGE', FORMAT: 3 });
        const params = ['3', 'BTC', VALID_DEST, 'hello'];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('SOURCE'), `Expected SOURCE sleeping error, got: ${data['STATUS']}`);
    });

    // ─── Side-effect checks ───────────────────────────────────────────

    it('calls createMessage on the indexerDb', async function () {
        const data = createBaseData({ ACTION: 'MESSAGE', FORMAT: 3 });
        const params = ['3', 'BTC', VALID_DEST, 'hello'];
        await handler.parse(params, data, null);
        assert.ok(indexer.indexerDb.createMessage.calledOnce);
    });

    it('calls mapper.createMappings after parse', async function () {
        const data = createBaseData({ ACTION: 'MESSAGE', FORMAT: 3 });
        const params = ['3', 'BTC', VALID_DEST, 'hello'];
        await handler.parse(params, data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });
});
