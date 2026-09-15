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
 * test/unit/issue_bridge_optin.test.js
 *
 * ISSUE's half of the two bridge specs and the policy-inheritance activation:
 *
 *   - FORMAT 7, the issuer's bridge opt-in (BRIDGE_CHAINS, MIN_DEPTH, LOCK_BRIDGE),
 *     admitted only at/above TOKEN_BRIDGE_ACTIVATION and invisible below it;
 *   - the POLICY EXCLUSION in both directions, with the list half
 *     lifting at TOKEN_POLICY_INHERITANCE_ACTIVATION and the controller half never
 *     lifting here;
 *   - the ceiling on a bridgeable token's list membership;
 *   - the CASE-FOLDED reserved-tick guard with the regtest exemption narrowed to the
 *     GAS tick and a system-injected exemption;
 *   - the BRIDGE-OWNED closure: an XCHAIN ISSUE off BTC is refused unconditionally,
 *     with the same IS_GENESIS exemption the lazy off-BTC row creation needs.
 *
 * Both activation predicates are stubbed per case rather than driven by block
 * height, because both maps park at regtest 0 and the house sentinel everywhere
 * else: no real (network, height) pair produces "bridge armed, inheritance not",
 * which is precisely the milestone-1 state most of these verdicts describe.
 ********************************************************************/
const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../../fixtures/mocks');
const Issue                = require('../../../../src/actions/issue/index.js');
const tokenBridgeActivation = require('../../../../src/token_bridge_activation.js');
const tokenPolicyActivation = require('../../../../src/token_policy_activation.js');
const OWNER   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const STRANGER = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const GAS_ADDR = { BTC: '1XChain3M4uRwcHqt4XuhVBUQ8cL4qQsA', DOGE: 'DGasfpttCnTijuuoAdiJ9sXJjG7vQ5pMkW' };

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

// ISSUE format 7: VERSION|TICK|BRIDGE_CHAINS|MIN_DEPTH|LOCK_BRIDGE|MEMO
function format7(o = {}){
    const d = Object.assign({ TICK: 'FUFU', BRIDGE_CHAINS: '', MIN_DEPTH: '', LOCK_BRIDGE: '', MEMO: '' }, o);
    return ['7', d.TICK, d.BRIDGE_CHAINS, d.MIN_DEPTH, d.LOCK_BRIDGE, d.MEMO];
}

// ISSUE format 5: VERSION|TICK|ALLOW_LIST|BLOCK_LIST|MEMO (the list-params edit)
function format5(o = {}){
    const d = Object.assign({ TICK: 'FUFU', ALLOW_LIST: '', BLOCK_LIST: '', MEMO: '' }, o);
    return ['5', d.TICK, d.ALLOW_LIST, d.BLOCK_LIST, d.MEMO];
}

// A native, unlisted, unbound token row owned by OWNER.
function tokenRow(o = {}){
    return Object.assign({
        TICK: 'FUFU', TICK_ID: 7, OWNER: OWNER, MAX_SUPPLY: '1000', MAX_MINT: '0',
        DECIMALS: 0, DESCRIPTION: 'test', SUPPLY: '100',
        LOCK_MAX_SUPPLY: 0, LOCK_MINT: 0, LOCK_MINT_SUPPLY: 0, LOCK_MAX_MINT: 0,
        LOCK_DESCRIPTION: 0, LOCK_SLEEP: 0, LOCK_CALLBACK: 0, LOCK_BRIDGE: 0,
        ALLOW_LIST: null, BLOCK_LIST: null, BRIDGE_CHAINS: null, MIN_DEPTH: null,
        BRIDGED: 0, MINT_START_BLOCK: 0, MINT_STOP_BLOCK: 0, MINT_ADDRESS_MAX: 0,
        CALLBACK_BLOCK: 0, CALLBACK_TICK: null, CALLBACK_AMOUNT: 0
    }, o);
}

// Drive one ISSUE. `bridge` / `policy` are the two activation predicates.
async function run({ params, data = {}, token = null, controllers = null, list = null,
                     coin = 'BTC', network = 'regtest', bridge = true, policy = false } = {}){
    const indexer = createMockIndexer();
    indexer.config.COIN    = coin;
    indexer.config.NETWORK = network;
    if(GAS_ADDR[coin])
        indexer.config.ADDRESS.GAS = GAS_ADDR[coin];

    indexer.indexerDb.getTokenInfo.resolves(token);
    indexer.indexerDb.getTokenControllers.resolves(controllers || new Map());
    // A token row's list indexes are back-filled into every later ISSUE by the
    // populate-empty-params merge, and the generic list-validity check runs BEFORE the
    // bridge guards, so the mock has to admit them or every listed case stops at
    // 'invalid: <FIELD> (bad list)' instead of reaching the verdict under test.
    indexer.indexerDb.isValidList.resolves(true);
    if(list)
        indexer.indexerDb.getList.resolves(list);

    sinon.stub(tokenBridgeActivation, 'isTokenBridgeActive').returns(bridge);
    sinon.stub(tokenPolicyActivation, 'isTokenPolicyInheritanceActive').returns(policy);

    const handler = new Issue(makeActionsCtx(indexer));
    const d = createBaseData(Object.assign({ ACTION: 'ISSUE', FORMAT: Number(params[0]), BLOCK_INDEX: 500, SOURCE: OWNER }, data));
    await handler.parse(params, d, null);
    return { status: d.STATUS, indexer, data: d };
}
const SUBASSET = 'invalid: TICK (subassets are not bridgeable yet)';

module.exports = { assert, sinon, createMockIndexer, createBaseData, Issue, tokenBridgeActivation, tokenPolicyActivation, OWNER, STRANGER, GAS_ADDR, makeActionsCtx, format7, format5, tokenRow, run, SUBASSET };
