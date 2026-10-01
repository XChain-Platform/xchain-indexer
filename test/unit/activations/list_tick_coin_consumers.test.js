'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const { stubActiveAt } = require('../../helpers/gate_modules.js');
const Airdrop = require('../../../src/actions/airdrop/index.js');
const Issue = require('../../../src/actions/issue/index.js');

const GATE = 'list_tick_coin_activation.LIST_TICK_COIN_ACTIVATION';
const OWNER = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

function makeActionsCtx(indexer){
    return {
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: indexer.protocolChanges,
        processAction: sinon.stub().resolves(),
    };
}

function createIssue(tick){
    return ['0', tick, '1000', '100', '0', 'coin prefix drill', '0',
            '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
}

function editIssue(tick){
    return ['1', tick, 'edited description', ''];
}

function tokenRow(tick){
    return {
        TICK: tick, TICK_ID: 9, OWNER, MAX_SUPPLY: '1000', MAX_MINT: '100',
        DECIMALS: 0, DESCRIPTION: 'existing row', SUPPLY: '0',
        LOCK_MAX_SUPPLY: 0, LOCK_MINT: 0, LOCK_MINT_SUPPLY: 0, LOCK_MAX_MINT: 0,
        LOCK_DESCRIPTION: 0, LOCK_SLEEP: 0, LOCK_CALLBACK: 0, LOCK_BRIDGE: 0,
        ALLOW_LIST: null, BLOCK_LIST: null, BRIDGE_CHAINS: null, MIN_DEPTH: null,
        BRIDGED: 0, MINT_ADDRESS_MAX: 0, MINT_START_BLOCK: 0, MINT_STOP_BLOCK: 0,
        CALLBACK_BLOCK: 0, CALLBACK_TICK: null, CALLBACK_AMOUNT: 0,
    };
}

async function runIssue({ tick, active, existing = null, edit = false }){
    const indexer = createMockIndexer();
    indexer.config.COIN = 'BTC';
    indexer.config.NETWORK = 'regtest';
    indexer.config.COINS = ['BTC', 'LTC', 'DOGE'];

    const reads = [];
    indexer.indexerDb.getTokenInfo.callsFake(async value => {
        reads.push({ tick: value, suppressed: indexer.indexerDb.suppressIndexIdCreation === true });
        if(existing && (value === tick || value === '^9'))
            return existing;
        return null;
    });
    indexer.indexerDb.isValidList.resolves(true);
    indexer.indexerDb.getTickerId.resolves(1);
    indexer.indexerDb.getAddressBalances.resolves({ 1: '100000000' });
    stubActiveAt(sinon, GATE, active);

    const handler = new Issue(makeActionsCtx(indexer));
    const params = edit ? editIssue(tick) : createIssue(tick);
    const data = createBaseData({ ACTION: 'ISSUE', FORMAT: Number(params[0]), BLOCK_INDEX: 500, SOURCE: OWNER });
    await handler.parse(params, data, null);
    return { status: data.STATUS, indexer, reads };
}

describe('LIST_TICK_COIN consumers @regression @consensus', function(){
    afterEach(function(){ sinon.restore(); });

    describe('AIRDROP ticker-list expansion', function(){
        function handlerFixture(active){
            const indexer = createMockIndexer();
            indexer.config.COIN = 'BTC';
            indexer.config.NETWORK = 'regtest';
            indexer.config.COINS = ['BTC', 'LTC', 'DOGE'];
            stubActiveAt(sinon, GATE, active);
            const handler = new Airdrop(makeActionsCtx(indexer));
            return { indexer, handler };
        }

        it('expands bare and own-coin items while skipping unresolved and foreign items when armed', async function(){
            const { indexer, handler } = handlerFixture(true);
            indexer.indexerDb.getTickerId.callsFake(async tick => tick === '^5' ? 5 : null);
            indexer.indexerDb.getHolders.callsFake(async tick => ({
                FOO: { bareHolder: '10' },
                '^5': { idHolder: '20' },
            }[tick] || {}));

            const data = createBaseData({ ACTION: 'AIRDROP', BLOCK_INDEX: 500, ACTION_INDEX: 12 });
            const recipients = await handler.expandAirdropRecipients(1, ['FOO', 'BTC:^5', 'BTC:NOPE', 'DOGE:PEPE'], data, null);

            assert.deepStrictEqual(Array.from(recipients), ['bareHolder', 'idHolder']);
            assert.deepStrictEqual(indexer.indexerDb.getTickerId.getCalls().map(call => call.args[0]), ['^5', 'NOPE']);
            assert.deepStrictEqual(indexer.indexerDb.getHolders.getCalls().map(call => call.args), [
                ['FOO', 500, 12],
                ['^5', 500, 12],
            ]);
        });

        it('passes every item unchanged to the legacy holder loop below the gate', async function(){
            const { indexer, handler } = handlerFixture(false);
            indexer.indexerDb.getHolders.resolves({ holder: '1' });
            const items = ['FOO', 'BTC:^5', 'BTC:NOPE', 'DOGE:PEPE'];
            const data = createBaseData({ ACTION: 'AIRDROP', BLOCK_INDEX: 499, ACTION_INDEX: 11 });

            await handler.expandAirdropRecipients(1, items, data, null);

            assert.deepStrictEqual(indexer.indexerDb.getHolders.getCalls().map(call => call.args), items.map(tick => [tick, 499, 11]));
            sinon.assert.notCalled(indexer.indexerDb.getTickerId);
        });
    });

    describe('ISSUE coin-qualified root reservation', function(){
        it('leaves the historical colon ticker verdict unchanged below the gate', async function(){
            const result = await runIssue({ tick: 'BTC:FOO', active: false });
            assert.strictEqual(result.status, 'valid');
            assert.strictEqual(result.reads[0].suppressed, false);
        });

        it('refuses live and future coin roots without interning their ticker names', async function(){
            for(const tick of ['BTC:FOO', 'doge:X', 'ETH:FOO']){
                const result = await runIssue({ tick, active: true });
                assert.strictEqual(result.status, 'invalid: TICK (reserved)', tick);
                assert.ok(result.reads.length > 0, tick);
                assert.ok(result.reads.every(read => read.suppressed), tick);
                sinon.assert.notCalled(result.indexer.indexerDb.createTicker);
                sinon.restore();
            }
        });

        it('admits strings the list parser does not read as coin-qualified', async function(){
            for(const tick of ['FOO:BTC', 'BTCX:FOO', ':FOO']){
                const result = await runIssue({ tick, active: true });
                assert.strictEqual(result.status, 'valid', tick);
                sinon.restore();
            }
        });

        it('keeps a pre-existing qualified ticker editable by name and caret id', async function(){
            const existing = tokenRow('BTC:OLD');
            let result = await runIssue({ tick: 'BTC:OLD', active: true, existing, edit: true });
            assert.strictEqual(result.status, 'valid');
            assert.strictEqual(result.reads[0].suppressed, true);

            sinon.restore();
            result = await runIssue({ tick: '^9', active: true, existing, edit: true });
            assert.strictEqual(result.status, 'valid');
            assert.strictEqual(result.reads[0].suppressed, false);
        });
    });
});
