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
            SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            SWAP_STATUS: 'open',
            GIVE_COIN: 'BTC', GIVE_TICK: 'GIVE', GIVE_AMOUNT: '10',
            GET_COIN: 'BTC',  GET_TICK: 'GET',   GET_AMOUNT: '5',
            GET_ADDRESS: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            ALLOW_LIST: null, BLOCK_LIST: null,
            ...overrides,
        };
    }

    function makeMatchInfo(overrides) {
        return {
            ACTION_INDEX: 20,
            SOURCE: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
            GIVE_TICK: 'GET',  GIVE_AMOUNT: '5',
            GET_TICK: 'GIVE',  GET_AMOUNT: '10',
            GET_ADDRESS: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
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

    // ─── Ownership-transfer settlement sides (GIVE_OWNERSHIP = 1) ─────────
    // The default tests cover the balance-escrow path. An ownership offer only
    // matches another ownership offer (the GIVE/GET_OWNERSHIP mirror filter), so
    // an ownership-for-ownership swap drives BOTH ownership branches at once
    // (swapInfo.GIVE side + matchInfo.GIVE side).

    it('transfers ownership on both sides for an ownership-for-ownership swap', async function () {
        indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
        const swapInfo  = makeSwapInfo({ GIVE_OWNERSHIP: 1, GET_OWNERSHIP: 1 });
        const matchInfo = makeMatchInfo({ GIVE_OWNERSHIP: 1, GET_OWNERSHIP: 1 });
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        indexer.indexerDb.findSwapMatches.resolves([matchInfo]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        // two ownership transfers → two transfer-ISSUEs, escrow gate cleared twice
        assert.strictEqual(indexer.indexerDb.clearTokenEscrow.callCount, 2);
        assert.ok(indexer.indexerDb.createIssue.called);
        assert.ok(indexer.indexerDb.createSwapMatch.calledOnce);
    });

    it('mixed: balance offer never matches an ownership offer (mirror filter)', async function () {
        const swapInfo  = makeSwapInfo({ GIVE_OWNERSHIP: 1, GET_OWNERSHIP: 1 });
        const matchInfo = makeMatchInfo(); // balance offer (ownership 0/0)
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        indexer.indexerDb.findSwapMatches.resolves([matchInfo]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapMatch.notCalled);
    });

    // ─── SWAP_ACTION_INDEX selects the swap to resolve ────────────────────
    it('resolves the swap by SWAP_ACTION_INDEX when present', async function () {
        const swapInfo  = makeSwapInfo();
        const matchInfo = makeMatchInfo();
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        indexer.indexerDb.findSwapMatches.resolves([matchInfo]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200, SWAP_ACTION_INDEX: 7 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.getSwapInfo.calledWith('BTC', 7));
        assert.ok(indexer.indexerDb.createSwapMatch.calledOnce);
    });

    // ─── Token ALLOW/BLOCK list filtering (rejects the match) ─────────────
    // Helper: re-stub getTokenInfo so GET / GIVE tokens carry a list id, and
    // getList returns the list contents for that id.
    function withTokenLists({ getList, giveList }) {
        indexer.indexerDb.getTokenInfo.callsFake(async (tick) => {
            if (tick === 'GET')  return createTokenInfo({ TICK: 'GET',  ALLOW_LIST: getList?.allow ?? null, BLOCK_LIST: getList?.block ?? null });
            if (tick === 'GIVE') return createTokenInfo({ TICK: 'GIVE', ALLOW_LIST: giveList?.allow ?? null, BLOCK_LIST: giveList?.block ?? null });
            return null;
        });
    }

    it('rejects a match absent from the GET-token ALLOW_LIST', async function () {
        withTokenLists({ getList: { allow: 11 } });
        indexer.indexerDb.getList.callsFake(async (id) => (id === 11 ? ['1OtherOnlyXXXXXXXXXXXXXXXXXXXXXXXX'] : []));
        indexer.indexerDb.getSwapInfo.resolves(makeSwapInfo());
        indexer.indexerDb.findSwapMatches.resolves([makeMatchInfo()]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapMatch.notCalled);
    });

    it('rejects a match whose address is on the GET-token BLOCK_LIST', async function () {
        withTokenLists({ getList: { block: 12 } });
        indexer.indexerDb.getList.callsFake(async (id) => (id === 12 ? ['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM'] : []));
        indexer.indexerDb.getSwapInfo.resolves(makeSwapInfo());
        indexer.indexerDb.findSwapMatches.resolves([makeMatchInfo()]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapMatch.notCalled);
    });

    it('rejects a match absent from the GIVE-token ALLOW_LIST', async function () {
        withTokenLists({ giveList: { allow: 13 } });
        indexer.indexerDb.getList.callsFake(async (id) => (id === 13 ? ['1OtherOnlyXXXXXXXXXXXXXXXXXXXXXXXX'] : []));
        indexer.indexerDb.getSwapInfo.resolves(makeSwapInfo());
        indexer.indexerDb.findSwapMatches.resolves([makeMatchInfo()]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapMatch.notCalled);
    });

    it('rejects a match whose address is on the GIVE-token BLOCK_LIST', async function () {
        withTokenLists({ giveList: { block: 14 } });
        indexer.indexerDb.getList.callsFake(async (id) => (id === 14 ? ['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM'] : []));
        indexer.indexerDb.getSwapInfo.resolves(makeSwapInfo());
        indexer.indexerDb.findSwapMatches.resolves([makeMatchInfo()]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapMatch.notCalled);
    });

    it('rejects when the swap ALLOW_LIST excludes the match address', async function () {
        const swapInfo = makeSwapInfo({ ALLOW_LIST: 21 });
        indexer.indexerDb.getList.callsFake(async (id) => (id === 21 ? ['1OtherOnlyXXXXXXXXXXXXXXXXXXXXXXXX'] : []));
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        indexer.indexerDb.findSwapMatches.resolves([makeMatchInfo()]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapMatch.notCalled);
    });

    it('rejects when the match ALLOW_LIST excludes the swap address', async function () {
        const matchInfo = makeMatchInfo({ ALLOW_LIST: 31 });
        indexer.indexerDb.getList.callsFake(async (id) => (id === 31 ? ['1OtherOnlyXXXXXXXXXXXXXXXXXXXXXXXX'] : []));
        indexer.indexerDb.getSwapInfo.resolves(makeSwapInfo());
        indexer.indexerDb.findSwapMatches.resolves([matchInfo]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapMatch.notCalled);
    });

    it('rejects when the swap address is on the match BLOCK_LIST', async function () {
        const matchInfo = makeMatchInfo({ BLOCK_LIST: 41 });
        indexer.indexerDb.getList.callsFake(async (id) => (id === 41 ? ['mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH'] : []));
        indexer.indexerDb.getSwapInfo.resolves(makeSwapInfo());
        indexer.indexerDb.findSwapMatches.resolves([matchInfo]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapMatch.notCalled);
    });

    // ALLOW_LIST that contains the swap's GET_ADDRESS but NOT the match address —
    // drives the second operand of the allow-list short-circuit.
    it('rejects when GET ALLOW_LIST has the swap address but not the match address', async function () {
        withTokenLists({ getList: { allow: 51 } });
        indexer.indexerDb.getList.callsFake(async (id) =>
            (id === 51 ? ['mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH'] : []));
        indexer.indexerDb.getSwapInfo.resolves(makeSwapInfo());
        indexer.indexerDb.findSwapMatches.resolves([makeMatchInfo()]);
        const data = createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapMatch.notCalled);
    });
});
