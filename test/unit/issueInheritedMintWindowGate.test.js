'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// ISSUE_INHERITED_MINT_WINDOW gate: at/above the activation the mint-window
// recency checks (MINT_START_BLOCK / MINT_STOP_BLOCK >= current block) apply
// only to values the ISSUE explicitly carries on the wire; values inherited
// from the existing token record by the populate-empty-params merge are
// exempt, so a token whose mint window has opened can still be
// re-parameterized by its owner. Below the activation the legacy behaviour
// (inherited values checked too, so such re-issues reject) is preserved for
// from-genesis replay identity.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../fixtures/mocks');
const Issue = require('../../src/actions/issue.js');
const {
    ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME,
    ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME,
} = require('../../src/protocol_changes.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

// Format 0 wire params for an owner re-ISSUE of TEST. Window fields default to
// EMPTY (the re-parameterization shape: raise the caps, leave the window alone).
function makeReissueParams(overrides = {}) {
    const fields = Object.assign({
        VERSION: '0',          TICK: 'TEST',
        MAX_SUPPLY: '',        MAX_MINT: '200',
        DECIMALS: '',          DESCRIPTION: '',
        MINT_SUPPLY: '',       TRANSFER: '',       TRANSFER_SUPPLY: '',
        LOCK_MAX_SUPPLY: '',   LOCK_MAX_MINT: '',  LOCK_DESCRIPTION: '',
        LOCK_SLEEP: '',        LOCK_CALLBACK: '',
        CALLBACK_BLOCK: '',    CALLBACK_TICK: '',  CALLBACK_AMOUNT: '',
        ALLOW_LIST: '',        BLOCK_LIST: '',
        MINT_ADDRESS_MAX: '',  MINT_START_BLOCK: '', MINT_STOP_BLOCK: '',
        LOCK_MINT: '',         LOCK_MINT_SUPPLY: '', MEMO: '',
    }, overrides);
    return [
        fields.VERSION, fields.TICK, fields.MAX_SUPPLY, fields.MAX_MINT,
        fields.DECIMALS, fields.DESCRIPTION, fields.MINT_SUPPLY,
        fields.TRANSFER, fields.TRANSFER_SUPPLY, fields.LOCK_MAX_SUPPLY,
        fields.LOCK_MAX_MINT, fields.LOCK_DESCRIPTION, fields.LOCK_SLEEP,
        fields.LOCK_CALLBACK, fields.CALLBACK_BLOCK, fields.CALLBACK_TICK,
        fields.CALLBACK_AMOUNT, fields.ALLOW_LIST, fields.BLOCK_LIST,
        fields.MINT_ADDRESS_MAX, fields.MINT_START_BLOCK,
        fields.MINT_STOP_BLOCK, fields.LOCK_MINT, fields.LOCK_MINT_SUPPLY,
        fields.MEMO,
    ];
}

describe('ISSUE_INHERITED_MINT_WINDOW gate @regression @tier2', function () {
    let indexer, handler, gateOn;

    function makeActionsCtx() {
        return {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().callsFake(async (name, block) => {
                    if (name === 'ISSUANCE_FEE') return Number(block) >= 862633;
                    if (name === 'ISSUE_INHERITED_MINT_WINDOW') return gateOn;
                    return true;
                }),
            },
            processAction: sinon.stub().resolves(),
        };
    }

    // Existing token whose mint window OPENED at 50 (and closed at 150 where a
    // stop block is set); every test issues at block 200, past both.
    function stubExistingToken(overrides = {}) {
        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo(Object.assign({
            TICK: 'TEST', OWNER: SOURCE, SUPPLY: '0',
            MAX_SUPPLY: '1000', MAX_MINT: '100',
            MINT_START_BLOCK: '50', MINT_STOP_BLOCK: null,
        }, overrides)));
    }

    async function parseReissue(paramOverrides = {}) {
        const params = makeReissueParams(paramOverrides);
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 200, SOURCE });
        await handler.parse(params, data, null);
        return data;
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        gateOn  = true;
        handler = new Issue(makeActionsCtx());
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.isDistributed.resolves(false);
        indexer.indexerDb.getAddressBalances.resolves({});
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTokenSupply.resolves('0');
    });

    afterEach(function () { sinon.restore(); });

    it('gate ON: re-ISSUE inheriting an opened MINT_START_BLOCK is valid', async function () {
        stubExistingToken();
        const data = await parseReissue();
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('gate ON: re-ISSUE inheriting a CLOSED window (past stop block too) is valid', async function () {
        stubExistingToken({ MINT_STOP_BLOCK: '150' });
        const data = await parseReissue();
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('gate ON: an EXPLICIT past MINT_START_BLOCK is still rejected', async function () {
        stubExistingToken();
        const data = await parseReissue({ MINT_START_BLOCK: '50' });
        assert.strictEqual(data.STATUS, 'invalid: MINT_START_BLOCK < BLOCK_INDEX');
    });

    it('gate ON: an EXPLICIT past MINT_STOP_BLOCK is still rejected', async function () {
        stubExistingToken();
        const data = await parseReissue({ MINT_STOP_BLOCK: '150' });
        assert.strictEqual(data.STATUS, 'invalid: MINT_STOP_BLOCK < BLOCK_INDEX');
    });

    it('gate ON: an explicit FUTURE window still validates', async function () {
        stubExistingToken();
        const data = await parseReissue({ MINT_START_BLOCK: '300', MINT_STOP_BLOCK: '400' });
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('gate ON: stop-before-start cross-check still runs on the MERGED window', async function () {
        // Inherited future start (300); explicit stop (250) passes recency but
        // lands before the effective start, so the effective window is refused.
        stubExistingToken({ MINT_START_BLOCK: '300' });
        const data = await parseReissue({ MINT_STOP_BLOCK: '250' });
        assert.strictEqual(data.STATUS, 'invalid: MINT_STOP_BLOCK < MINT_START_BLOCK');
    });

    it('gate OFF: the legacy rejection of an inherited opened window is preserved', async function () {
        gateOn = false;
        stubExistingToken();
        const data = await parseReissue();
        assert.strictEqual(data.STATUS, 'invalid: MINT_START_BLOCK < BLOCK_INDEX');
    });

    it('mainnet stays on the house UNARMED sentinel until the operator names an instant', function () {
        assert.strictEqual(ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME, 9999999999);
    });

    it('testnet arm is the ratified instant, re-pinned forward to 2026-08-29T00:00:00Z', function () {
        assert.strictEqual(ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME, 1787961600);
        assert.strictEqual(new Date(ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME * 1000).toISOString(),
            '2026-08-29T00:00:00.000Z');
    });
});
