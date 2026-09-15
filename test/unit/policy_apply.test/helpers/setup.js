'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

const assert  = require('assert');
const crypto  = require('crypto');
const eq      = require('../../../../src/equivocation_header.js');
const BS      = require('../../../../src/consensus/bridge_settle.js');
const Utility = require('../../../../src/utility.js');
const { XPOLICY_MAX_PER_BLOCK } = require('../../../../src/protocol/constants.js');
const bridgeSettlementsMixin = require('../../../../src/db/bridge_settlements/index.js');

// The pass reaches both the local settlements ledger and the mirror through the
// db/bridge_settlements methods, so the doubles below carry the REAL ones bound over their
// own doQuery: the SQL predicates this file matches on are the statements that ship.
function bindSettlementReads(db){
    for(const m of Reflect.ownKeys(bridgeSettlementsMixin))
        db[m] = bridgeSettlementsMixin[m].bind(db);
    return db;
}

function makeKey(){
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { pubkey: spki.subarray(spki.length - 32).toString('hex'), privateKey };
}
function sign(privateKey, msg){
    return crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('hex');
}
function snapshotSet(keys){
    return keys.map((k, i) => ({ pubkey: k.pubkey, source: 'src' + i, weight: '100' }));
}

const NETWORK  = 'regtest';
const SNAPSHOT = 1200;
const ORIGIN   = 'BTC';
const NAME     = 'PEPECASH';
const COPY     = ORIGIN + '.' + NAME;
const BRIDGE_BTC_ON_DOGE = 'nDOGEEscrowForBtcXXXXXXXXXXXXXXXXX';
// Canonical (byte) order, so the fixture is already what the hub hashed.
const ADDR_A = 'nAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_B = 'nBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDR_C = 'nCcccccccccccccccccccccccccccccccc';

// A policy snapshot row. `policy_hash` is computed by the MODULE'S OWN hasher from the same
// arrays the row carries, which is what makes the tampering cases below real: change the
// array without re-signing and the recomputation no longer matches.
function makeSnapshot(signers, overrides){
    const o = overrides || {};
    const allow = (o.allow !== undefined) ? o.allow : null;
    const block = (o.block !== undefined) ? o.block : null;
    const sleeping = !!o.sleeping;
    const row = Object.assign({
        snapshot_id:     'd'.repeat(64),
        snapshot_block:  SNAPSHOT,
        origin_chain:    ORIGIN,
        tick:            NAME,
        policy_seq:      1,
        origin_block:    500,
        policy_hash:     BS.policyHash(allow, block, sleeping),
        allow_list:      allow === null ? null : JSON.stringify(allow),
        block_list:      block === null ? null : JSON.stringify(block),
        sleeping:        sleeping ? 1 : 0,
        effective_time:  1000,
        network:         NETWORK,
        finalizing_view: 0,
        status:          'finalized',
        push_generation: 0,
        btc_chain_id:    null
    }, o.row || {});
    row.validator_signatures = JSON.stringify(
        (signers || []).map(s => ({ pubkey: s.pubkey, sig: sign(s.privateKey, BS.policyCanonical(row)) })));
    return row;
}

function makePolicyConfig(){
    return {
        COIN: 'DOGE', NETWORK: NETWORK, GAS: 'XCHAIN',
        ADDRESS: { GAS: 'nGasOwnerXXXXXXXXXXXXXXXXXXXXXXXXX', BRIDGE_BTC: BRIDGE_BTC_ON_DOGE },
        BTC_CHAIN_ID: null
    };
}

function makeCtx(opts){
    const o = opts || {};
    const config = makePolicyConfig();
    const state = { injected: [], settlements: [], actions: [], settled: new Set(o.settled || []),
                    mirrorPolicies: o.mirrorPolicies || [] };
    let nextAction = 7000;
    const tokens = o.tokens || { [COPY]: { TICK_ID: 11, DECIMALS: 2, ALLOW_LIST: null, BLOCK_LIST: null } };

    const db = bindSettlementReads({
        config: config,
        mirrorDb: () => bindSettlementReads({ doQuery: async (sql, args) => {
            if(!/policy_snapshots/.test(sql)) return [];
            // The earlier-seq probe is a narrow query; the fake applies its predicate so the
            // gap case exercises the real filter rather than the whole mirror.
            if(/policy_seq < \?/.test(sql))
                return state.mirrorPolicies.filter(r => String(r.origin_chain) === String(args[1]) &&
                                                        String(r.tick) === String(args[2]) &&
                                                        Number(r.policy_seq) < Number(args[3]))
                                           .sort((a, b) => Number(a.policy_seq) - Number(b.policy_seq));
            return state.mirrorPolicies.slice();
        }}),
        doQuery: async (sql, args) => {
            if(/FROM bridge_settlements/.test(sql) && /LIMIT 1/.test(sql))
                return state.settled.has(String(args[0]) + '|' + String(args[1])) ? [{ transfer_id: args[0] }] : [];
            if(/FROM bridge_settlements/.test(sql)){
                const kind = /kind = 'policy'/.test(sql) ? 'policy' : 'transfer';
                return (args || []).filter(id => state.settled.has(String(id) + '|' + kind)).map(id => ({ transfer_id: id }));
            }
            if(/INSERT IGNORE INTO bridge_settlements/.test(sql)){
                state.settlements.push({ action_index: args[0], transfer_id: args[1], kind: args[2] });
                state.settled.add(String(args[1]) + '|' + String(args[2]));
            }
            return [];
        },
        getValidatorsByCapability:   async () => (o.validators || []),
        getStakeWeightsByCapability: async () => (o.validators || []),
        getTickerId:    async (tick) => (tokens[tick] ? tokens[tick]['TICK_ID'] : null),
        getTokenInfo:   async (tick) => tokens[tick] || null,
        getList:        async (idx) => (o.lists || {})[String(idx)] || [],
        isTickSleeping: async () => !!o.currentlySleeping,
        createActionIndex: async (d) => { state.actions.push(d); return nextAction++; },
        updateBalances: async () => {},
        updateTokens:   async () => {}
    });
    const ctx = {
        actions: {
            processTransaction: async (tx) => {
                state.injected.push(tx);
                return { ACTION_INDEX: nextAction++, STATUS: (o.legStatus || 'valid') };
            },
            mapper: { createMappings: async () => {} }
        },
        indexerDb: db, util: new Utility(config), mapper: { createMappings: async () => {} },
        config: config, coin: 'DOGE', network: NETWORK, blockIndex: 900, blockTime: 2000
    };
    return { ctx, state };
}


module.exports = {
    assert, crypto, eq, BS, Utility, XPOLICY_MAX_PER_BLOCK,
    bindSettlementReads, makeKey, sign, snapshotSet,
    NETWORK, SNAPSHOT, ORIGIN, NAME, COPY, BRIDGE_BTC_ON_DOGE,
    ADDR_A, ADDR_B, ADDR_C, makeSnapshot, makePolicyConfig, makeCtx,
};
