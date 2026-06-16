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
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Sleep = require('../../../src/actions/sleep.js');

describe('Sleep @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const OWNER  = SOURCE;
    const OTHER  = '1OtherAddressXXXXXXXXXXXXXXXXVtKwXp';

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: {
                isDefined:  sinon.stub().returns(true),
                isEnabled:  sinon.stub().resolves(true),
            },
            processAction:   sinon.stub().resolves(),
        };
        handler = new Sleep(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── Format 0: Sleep ADDRESS ──────────────────────────────────────

    describe('format 0 — sleep ADDRESS', function () {

        it('valid address sleep — createSleep called with valid status', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            const params = ['0', '200', 'memo'];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createSleep.called);
        });

        it('TYPE set to ADDRESS for format 0', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            const params = ['0', '200', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['TYPE'], 'ADDRESS');
        });

        it('RESUME_BLOCK in the future is valid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            const params = ['0', '500', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('RESUME_BLOCK === BLOCK_INDEX is valid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            const params = ['0', '100', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('RESUME_BLOCK < BLOCK_INDEX and not in immediate methods → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            // block 50 < 100 and not an immediate method (-1 or 0)
            const params = ['0', '50', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('RESUME_BLOCK = -1 (indefinite sleep) → valid (immediate method)', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            const params = ['0', '-1', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('RESUME_BLOCK = 0 (resume immediately) → valid (immediate method)', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            const params = ['0', '0', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });

    });

    // ─── Format 1: Sleep TICK ─────────────────────────────────────────

    describe('format 1 — sleep TICK', function () {

        it('valid tick sleep by owner — createSleep called with valid status', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, OWNER });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 1, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['1', '200', 'TEST', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['TYPE'], 'TICK');
        });

        it('non-owner cannot sleep TICK → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, OWNER });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 1, SOURCE: OTHER, BLOCK_INDEX: 100 });
            const params = ['1', '200', 'TEST', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('TICK not found → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 1, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['1', '200', 'UNKNOWN', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('RESUME_BLOCK < BLOCK_INDEX for TICK sleep → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, OWNER });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 1, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['1', '50', 'TEST', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    // ─── SOURCE sleeping ─────────────────────────────────────────────

    describe('SOURCE sleeping', function () {

        it('SOURCE sleeping → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.callsFake((address, tick, block) => {
                if (address && !tick) return Promise.resolve(false);
                return Promise.resolve(true);
            });

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            const params = ['0', '200', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    // ─── MEMO validations ────────────────────────────────────────────

    describe('MEMO validations', function () {

        it('MEMO with pipe → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            const params = ['0', '200', 'bad|memo'];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('MEMO with semicolon → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            const params = ['0', '200', 'bad;memo'];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    // ─── Record creation ─────────────────────────────────────────────

    describe('record creation', function () {

        it('createSleep called even on invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            // Past block — invalid
            const params = ['0', '50', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createSleep.called);
        });

        it('mapper.createMappings called after parse', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            const params = ['0', '200', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.called);
        });

        it('unknown format version → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SLEEP', FORMAT: 99, SOURCE, BLOCK_INDEX: 100 });
            const params = ['99', '200', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });
});
