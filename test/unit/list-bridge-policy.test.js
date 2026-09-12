'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/list-bridge-policy.test.js
 *
 * LIST's three rules from the policy-inheritance milestone and the owner check:
 *
 *   - ANY-COIN ITEMS behind TOKEN_POLICY_INHERITANCE_ACTIVATION. A bridged copy
 *     inherits ONE list from its origin row, so that list has to be able to name
 *     holders on every chain a copy lives on. Below the flag an item is judged
 *     against this chain's coin alone, which is the historical rule. The real
 *     db.isAnyCoinAddress is driven here, not a fake, because the widening is a
 *     loop over the existing coin-and-network-aware validator and a fake would
 *     prove nothing about it.
 *
 *   - THE BRIDGE-OWNED EDIT REFUSAL, unconditional. A materialized policy list on a
 *     bridged copy is signed issuer policy carried from another chain; a broadcast
 *     edit of it would let any address rewrite an issuer's allow or block list on
 *     every chain holding a copy. Injected edits carry IS_GENESIS and are exempt.
 *
 *   - THE GENERAL OWNER CHECK, behind LIST_OWNER_ACTIVATION. LIST edits had
 *     no owner check anywhere: any address could edit any issuer's list, and those
 *     lists gate SEND, ORDER, DISPENSER, AIRDROP, DIVIDEND, BET and SWAP on every
 *     listed token. Flag-gated because it re-verdicts historical third-party edits.
 ********************************************************************/

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');
const List                  = require('../../src/actions/list.js');
const Database              = require('../../src/db.js');
const listOwnerActivation   = require('../../src/list_owner_activation.js');
const tokenPolicyActivation = require('../../src/token_policy_activation.js');

// A real address of each chain on mainnet, so "valid here" and "valid on another
// supported coin" are genuinely different questions for the validator.
const BTC_MAINNET  = '1XChain3M4uRwcHqt4XuhVBUQ8cL4qQsA';
const DOGE_MAINNET = 'DGasfpttCnTijuuoAdiJ9sXJjG7vQ5pMkW';

const OWNER      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const STRANGER   = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const BRIDGE_BTC = 'n2eMqTT929pb1RDNuqEnxdaLau1rxy3efi';

function makeActionsCtx(indexer){
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: indexer.protocolChanges,
        processAction:   sinon.stub().resolves(),
    };
}

function makeIndexer({ coin = 'BTC', network = 'mainnet', bridgeAddresses = {} } = {}){
    const indexer = createMockIndexer();
    indexer.config.COIN         = coin;
    indexer.config.NETWORK      = network;
    indexer.util.config.COIN    = coin;
    indexer.util.config.NETWORK = network;
    Object.assign(indexer.config.ADDRESS, bridgeAddresses);
    // Drive the REAL widening rather than a stub: it is the rule under test.
    indexer.indexerDb.isAnyCoinAddress = Database.prototype.isAnyCoinAddress.bind({
        util: indexer.util, config: indexer.config
    });
    indexer.indexerDb.getListSource = sinon.stub().resolves(null);
    return indexer;
}

// LIST format 0: VERSION|TYPE|MEMO|ITEM...
async function runCreate(indexer, items){
    const handler = new List(makeActionsCtx(indexer));
    const data    = createBaseData({ ACTION: 'LIST', FORMAT: 0, BLOCK_INDEX: 500, SOURCE: OWNER });
    await handler.parse(['0', '2', ''].concat(items), data, null);
    return { status: data.STATUS, indexer };
}

// LIST format 1: VERSION|EDIT|LIST_ACTION_INDEX|MEMO|ITEM...
async function runEdit(indexer, { source = OWNER, items = [BTC_MAINNET], isGenesis = false } = {}){
    indexer.indexerDb.getListType.resolves(2);
    const handler = new List(makeActionsCtx(indexer));
    const data    = createBaseData({ ACTION: 'LIST', FORMAT: 1, BLOCK_INDEX: 500, SOURCE: source, IS_GENESIS: isGenesis });
    await handler.parse(['1', '1', '99', ''].concat(items), data, null);
    return data.STATUS;
}

describe('LIST bridge policy rules @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('any-coin items (TOKEN_POLICY_INHERITANCE_ACTIVATION)', function(){

        it('records a foreign-coin item invalid below the flag', async function(){
            sinon.stub(tokenPolicyActivation, 'isTokenPolicyInheritanceActive').returns(false);
            const indexer = makeIndexer({ coin: 'BTC', network: 'mainnet' });
            await runCreate(indexer, [DOGE_MAINNET]);
            assert.ok(indexer.indexerDb.createListItemInvalid.calledOnce,
                'a DOGE address must be recorded invalid on BTC below the flag');
            assert.strictEqual(indexer.indexerDb.createListItemInvalid.firstCall.args[2], 'invalid: ADDRESS (format)');
            assert.strictEqual(indexer.indexerDb.createListItem.callCount, 0);
        });

        it('admits a foreign-coin item at/above the flag', async function(){
            sinon.stub(tokenPolicyActivation, 'isTokenPolicyInheritanceActive').returns(true);
            const indexer = makeIndexer({ coin: 'BTC', network: 'mainnet' });
            await runCreate(indexer, [DOGE_MAINNET]);
            assert.strictEqual(indexer.indexerDb.createListItemInvalid.callCount, 0);
            assert.strictEqual(indexer.indexerDb.createListItem.callCount, 1);
            assert.strictEqual(indexer.indexerDb.createListItem.firstCall.args[1], DOGE_MAINNET);
        });

        it('still admits a local item below the flag, so nothing historical moves', async function(){
            sinon.stub(tokenPolicyActivation, 'isTokenPolicyInheritanceActive').returns(false);
            const indexer = makeIndexer({ coin: 'BTC', network: 'mainnet' });
            await runCreate(indexer, [BTC_MAINNET]);
            assert.strictEqual(indexer.indexerDb.createListItem.callCount, 1);
        });

        it('still refuses a string that is no coin address at any flag state', async function(){
            sinon.stub(tokenPolicyActivation, 'isTokenPolicyInheritanceActive').returns(true);
            const indexer = makeIndexer({ coin: 'BTC', network: 'mainnet' });
            await runCreate(indexer, ['not-an-address']);
            assert.strictEqual(indexer.indexerDb.createListItemInvalid.callCount, 1);
            assert.strictEqual(indexer.indexerDb.createListItem.callCount, 0);
        });
    });

    describe('bridge-owned edit refusal (unconditional)', function(){

        it('refuses a broadcast edit of a list created by a bridge role address', async function(){
            const indexer = makeIndexer({ coin: 'DOGE', network: 'mainnet', bridgeAddresses: { BRIDGE_BTC: BRIDGE_BTC } });
            indexer.indexerDb.getListSource.resolves(BRIDGE_BTC);
            assert.strictEqual(await runEdit(indexer, { source: BRIDGE_BTC }), 'invalid: LIST_ACTION_INDEX (bridge-owned)');
        });

        it('refuses it from a stranger too, not only from the role address', async function(){
            const indexer = makeIndexer({ coin: 'DOGE', network: 'mainnet', bridgeAddresses: { BRIDGE_BTC: BRIDGE_BTC } });
            indexer.indexerDb.getListSource.resolves(BRIDGE_BTC);
            assert.strictEqual(await runEdit(indexer, { source: STRANGER }), 'invalid: LIST_ACTION_INDEX (bridge-owned)');
        });

        it('exempts an injected edit, which is how a snapshot is materialized', async function(){
            const indexer = makeIndexer({ coin: 'DOGE', network: 'mainnet', bridgeAddresses: { BRIDGE_BTC: BRIDGE_BTC } });
            indexer.indexerDb.getListSource.resolves(BRIDGE_BTC);
            assert.strictEqual(await runEdit(indexer, { source: BRIDGE_BTC, isGenesis: true }), 'valid');
        });

        it('leaves an ordinary user list alone', async function(){
            const indexer = makeIndexer({ coin: 'DOGE', network: 'mainnet', bridgeAddresses: { BRIDGE_BTC: BRIDGE_BTC } });
            indexer.indexerDb.getListSource.resolves(OWNER);
            assert.strictEqual(await runEdit(indexer, { source: OWNER }), 'valid');
        });

        it('judges the ROOT create, so an unauthorized edit cannot launder authority', async function(){
            const indexer = makeIndexer({ coin: 'DOGE', network: 'mainnet', bridgeAddresses: { BRIDGE_BTC: BRIDGE_BTC } });
            indexer.indexerDb.getListRootIndex.resolves(7);
            indexer.indexerDb.getListSource.resolves(BRIDGE_BTC);
            await runEdit(indexer, { source: STRANGER });
            assert.ok(indexer.indexerDb.getListSource.calledWith(7),
                'the source read must be of the resolved root create, not the wire index');
        });
    });

    describe('owner check (LIST_OWNER_ACTIVATION)', function(){

        it('refuses a non-owner edit at/above the flag', async function(){
            sinon.stub(listOwnerActivation, 'isListOwnerCheckActive').returns(true);
            const indexer = makeIndexer({ coin: 'BTC', network: 'mainnet' });
            indexer.indexerDb.getListSource.resolves(OWNER);
            assert.strictEqual(await runEdit(indexer, { source: STRANGER }), 'invalid: LIST_ACTION_INDEX (not owner)');
        });

        it('admits the creator\'s own edit at/above the flag', async function(){
            sinon.stub(listOwnerActivation, 'isListOwnerCheckActive').returns(true);
            const indexer = makeIndexer({ coin: 'BTC', network: 'mainnet' });
            indexer.indexerDb.getListSource.resolves(OWNER);
            assert.strictEqual(await runEdit(indexer, { source: OWNER }), 'valid');
        });

        it('leaves a non-owner edit valid BELOW the flag, so replay is identical', async function(){
            sinon.stub(listOwnerActivation, 'isListOwnerCheckActive').returns(false);
            const indexer = makeIndexer({ coin: 'BTC', network: 'mainnet' });
            indexer.indexerDb.getListSource.resolves(OWNER);
            assert.strictEqual(await runEdit(indexer, { source: STRANGER }), 'valid');
        });

        it('exempts an injected edit even above the flag', async function(){
            sinon.stub(listOwnerActivation, 'isListOwnerCheckActive').returns(true);
            const indexer = makeIndexer({ coin: 'BTC', network: 'mainnet' });
            indexer.indexerDb.getListSource.resolves(OWNER);
            assert.strictEqual(await runEdit(indexer, { source: STRANGER, isGenesis: true }), 'valid');
        });

        it('does not touch a CREATE, which has no prior owner to compare against', async function(){
            sinon.stub(listOwnerActivation, 'isListOwnerCheckActive').returns(true);
            const indexer = makeIndexer({ coin: 'BTC', network: 'mainnet' });
            const { status } = await runCreate(indexer, [BTC_MAINNET]);
            assert.strictEqual(status, 'valid');
            assert.strictEqual(indexer.indexerDb.getListSource.callCount, 0);
        });
    });
});
