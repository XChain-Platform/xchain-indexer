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
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Swap_Match = require('../../../src/actions/swap_match.js');

describe('Swap_Match action handler @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    function makeSwapInfo(overrides) {
        return {
            ACTION_INDEX: 10,
            SOURCE: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            SWAP_STATUS: 'open',
            GIVE_COIN: 'BTC', GIVE_TICK: 'GIVE', GIVE_AMOUNT: '10',
            GET_COIN: 'BTC',  GET_TICK: 'GET',   GET_AMOUNT: '5',
            GET_ADDRESS: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            ALLOW_LIST: null, BLOCK_LIST: null,
            ...overrides,
        };
    }

    function makeMatchInfo(overrides) {
        return {
            ACTION_INDEX: 20,
            SOURCE: '1DestAddressXXXXXXXXXXXXXXXXXaKc5Z',
            GIVE_TICK: 'GET',  GIVE_AMOUNT: '5',
            GET_TICK: 'GIVE',  GET_AMOUNT: '10',
            GET_ADDRESS: '1DestAddressXXXXXXXXXXXXXXXXXaKc5Z',
            ALLOW_LIST: null, BLOCK_LIST: null,
            ...overrides,
        };
    }

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
        handler = new Swap_Match(actionsCtx);
        indexer.util.resetLists();

        const giveToken = createTokenInfo({ TICK: 'GIVE', TICK_ID: 1, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });
        const getToken  = createTokenInfo({ TICK: 'GET',  TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });
        indexer.indexerDb.getTokenInfo.callsFake(async (tick) => {
            if (tick === 'GIVE') return giveToken;
            if (tick === 'GET')  return getToken;
            return null;
        });
    });

    // ─── Returns early when swap is missing ───────────────────────────

    it('returns early when swapInfo is null', async function () {
        indexer.indexerDb.getSwapInfo.resolves(null);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapMatch.notCalled);
    });

    // ─── No match found ───────────────────────────────────────────────

    it('does nothing when no matching swaps are found', async function () {
        const swapInfo = makeSwapInfo();
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        indexer.indexerDb.findSwapMatches.resolves([]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapMatch.notCalled);
    });

    // ─── Match found ──────────────────────────────────────────────────

    it('processes match and creates swap_match record', async function () {
        const swapInfo  = makeSwapInfo();
        const matchInfo = makeMatchInfo();
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        indexer.indexerDb.findSwapMatches.resolves([matchInfo]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapMatch.calledOnce);
    });

    it('creates status records for both swaps on match', async function () {
        const swapInfo  = makeSwapInfo();
        const matchInfo = makeMatchInfo();
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        indexer.indexerDb.findSwapMatches.resolves([matchInfo]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        // Should have created two status records (one for each swap)
        assert.strictEqual(indexer.indexerDb.createSwapStatus.callCount, 2);
    });

    it('sets both swap statuses to complete', async function () {
        const swapInfo  = makeSwapInfo();
        const matchInfo = makeMatchInfo();
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        indexer.indexerDb.findSwapMatches.resolves([matchInfo]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        const statuses = indexer.indexerDb.createSwapStatus.args.map(a => a[2]);
        assert.ok(statuses.every(s => s === 'complete'), `Expected all complete, got: ${statuses}`);
    });

    // ─── Only first valid match is used ──────────────────────────────

    it('uses first valid match and ignores subsequent matches', async function () {
        const swapInfo   = makeSwapInfo();
        const matchInfo1 = makeMatchInfo({ ACTION_INDEX: 20 });
        const matchInfo2 = makeMatchInfo({ ACTION_INDEX: 30 });
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        indexer.indexerDb.findSwapMatches.resolves([matchInfo1, matchInfo2]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        // Should only create one match record (first valid match)
        assert.strictEqual(indexer.indexerDb.createSwapMatch.callCount, 1);
    });

    // ─── Block list prevents match ────────────────────────────────────

    it('skips match when matchInfo GET_ADDRESS is on swap block list', async function () {
        const swapInfo  = makeSwapInfo({ BLOCK_LIST: 999 });
        const matchInfo = makeMatchInfo({ GET_ADDRESS: '1BlockedAddressXXXXXXXXXXXXXXXXXXXX' });
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        indexer.indexerDb.findSwapMatches.resolves([matchInfo]);
        // Return the blocked address in the block list
        indexer.indexerDb.getList.callsFake(async (listId) => {
            if (listId === 999) return ['1BlockedAddressXXXXXXXXXXXXXXXXXXXX'];
            return [];
        });
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapMatch.notCalled, 'Should not match when address is blocked');
    });

    // ─── Side-effect checks ───────────────────────────────────────────

    it('calls mapper.createMappings when a match is found', async function () {
        const swapInfo  = makeSwapInfo();
        const matchInfo = makeMatchInfo();
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        indexer.indexerDb.findSwapMatches.resolves([matchInfo]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });

    it('calls updateBalances when a match is found', async function () {
        const swapInfo  = makeSwapInfo();
        const matchInfo = makeMatchInfo();
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        indexer.indexerDb.findSwapMatches.resolves([matchInfo]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.updateBalances.calledOnce);
    });

    it('does not call mapper.createMappings when no match is found', async function () {
        const swapInfo = makeSwapInfo();
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        indexer.indexerDb.findSwapMatches.resolves([]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.mapper.createMappings.notCalled);
    });
});
