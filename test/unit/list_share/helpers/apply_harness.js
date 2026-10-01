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

const { makeKey, sign, snapshotSet, bindSettlementReads } =
    require('../../bridge/policy_apply.test/helpers/setup.js');
const Utility = require('../../../../src/utility.js');
const listShareMirrorsMixin = require('../../../../src/db/list_share_mirrors/index.js');
const { deriveListSnapshotId } = require('../../../../src/consensus/list_share_settle/canonical.js');
const { listMembershipHash } = require('../../../../src/consensus/list_share_hash.js');

const NETWORK             = 'regtest';
const COIN                = 'BTC';
const HOME                = 'DOGE';
const HOME_LIST_INDEX     = 2701;
const SNAPSHOT_BLOCK      = 1200;
const BRIDGE_DOGE_ON_BTC  = 'nBTCEscrowForDogeXXXXXXXXXXXXXXXXX';
const BRIDGE_LTC_ON_BTC   = 'nBTCEscrowForLtcXXXXXXXXXXXXXXXXXX';

const byBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function bindMixins(db){
    bindSettlementReads(db);
    for(const m of Reflect.ownKeys(listShareMirrorsMixin))
        db[m] = listShareMirrorsMixin[m].bind(db);
    return db;
}

function makeListSnapshotRow({
    seq, added = [], removed = [], members, listType = 2, homeChain = HOME,
    homeListIndex = HOME_LIST_INDEX, snapshotBlock = SNAPSHOT_BLOCK, network = NETWORK,
    admit = { btc: 800, ltc: 800, doge: 800 }, status = 'finalized', membersHash,
}){
    const sorted = (members || added).slice().sort(byBytes);
    const height = (key) => (admit[key] === undefined ? null : admit[key]);
    return {
        id:                   seq,
        snapshot_id:          deriveListSnapshotId(network, homeChain, homeListIndex, seq, snapshotBlock),
        snapshot_block:       snapshotBlock,
        network:              network,
        home_chain:           homeChain,
        home_list_index:      homeListIndex,
        list_type:            listType,
        seq:                  seq,
        kind:                 seq === 1 ? 'full' : 'delta',
        added:                JSON.stringify(added),
        removed:              JSON.stringify(removed),
        members_hash:         membersHash || listMembershipHash(sorted),
        origin_block:         500,
        admit_block_btc:      height('btc'),
        admit_block_ltc:      height('ltc'),
        admit_block_doge:     height('doge'),
        finalizing_view:      0,
        validator_signatures: '[]',
        status:               status,
        btc_chain_id:         null,
    };
}

function signListRows(rows, signers, canonical){
    return rows.map((row) => {
        const signed = Object.assign({}, row);
        signed.validator_signatures = JSON.stringify(
            signers.map((s) => ({ pubkey: s.pubkey, sig: sign(s.privateKey, canonical(row)) })));
        return signed;
    });
}

function mirrorQuery(state, network){
    return async (sql, args) => {
        if(!/list_snapshots/.test(sql)) return [];
        const live = state.mirrorRows.filter((r) => r.status === 'finalized' && r.network === args[0]);
        if(/GROUP BY/.test(sql)){
            const heads = new Map();
            for(const r of live.filter((x) => x.home_chain !== args[1])){
                const key = r.home_chain + ':' + r.home_list_index;
                const head = heads.get(key);
                if(!head) heads.set(key, { home_chain: r.home_chain,
                                           home_list_index: r.home_list_index, max_seq: r.seq });
                else if(Number(r.seq) > Number(head.max_seq)) head.max_seq = r.seq;
            }
            return Array.from(heads.values());
        }
        const same = live.filter((r) => r.home_chain === args[1] &&
                                        Number(r.home_list_index) === Number(args[2]));
        if(/seq > \?/.test(sql))
            return same.filter((r) => Number(r.seq) > Number(args[3]))
                       .sort((a, b) => Number(a.seq) - Number(b.seq));
        return same.filter((r) => Number(r.seq) === Number(args[3]));
    };
}

function localQuery(state){
    return async (sql, args) => {
        if(/INSERT IGNORE INTO bridge_settlements/.test(sql)){
            const dup = state.settlements.some((s) => s.transfer_id === args[1] && s.kind === args[2]);
            if(!dup) state.settlements.push({
                action_index: args[0], transfer_id: args[1], kind: args[2], block_index: args[3],
                src_chain: args[4], src_action_index: args[5], dest_chain: args[6],
                dest_address: args[7], tick: args[8] });
            return [];
        }
        if(/FROM bridge_settlements/.test(sql) && /GROUP BY/.test(sql))
            return countApplied(state);
        if(/INSERT INTO list_share_mirrors/.test(sql)){
            state.mirrors.push({ action_index: args[0], home_chain: args[1],
                                 home_list_index: args[2], block_index: args[3] });
            return [];
        }
        if(/FROM list_share_mirrors/.test(sql)){
            const byIndex = /action_index = \?/.test(sql);
            return state.mirrors.filter((m) => byIndex
                ? Number(m.action_index) === Number(args[0])
                : m.home_chain === args[0] && Number(m.home_list_index) === Number(args[1]));
        }
        return [];
    };
}

function countApplied(state){
    const groups = new Map();
    for(const s of state.settlements.filter((x) => x.kind === 'list')){
        const key = s.src_chain + ':' + s.src_action_index;
        const g = groups.get(key) || { src_chain: s.src_chain,
                                       src_action_index: s.src_action_index, applied_seq: 0 };
        g.applied_seq += 1;
        groups.set(key, g);
    }
    return Array.from(groups.values());
}

function applyLeg(state, tx, nextAction){
    const f = tx.data.split('|');
    if(f[0] !== 'LIST') return { ACTION_INDEX: nextAction, STATUS: 'valid' };
    if(f[1] === '0'){
        state.lists.set(nextAction, { type: Number(f[2]), owner: tx.source, members: new Set(f.slice(4)) });
        return { ACTION_INDEX: nextAction, STATUS: 'valid' };
    }
    const list = state.lists.get(Number(f[3]));
    if(!list) return { ACTION_INDEX: nextAction, STATUS: 'invalid: LIST_ACTION_INDEX (unknown)' };
    for(const item of f.slice(5)){
        if(f[2] === '1') list.members.add(item);
        else list.members.delete(item);
    }
    return { ACTION_INDEX: nextAction, STATUS: 'valid' };
}

function makeListShareConfig(coin){
    return {
        COIN: coin, NETWORK: NETWORK, COINS: ['BTC', 'LTC', 'DOGE'],
        ADDRESS: { BRIDGE_DOGE: BRIDGE_DOGE_ON_BTC, BRIDGE_LTC: BRIDGE_LTC_ON_BTC },
        BTC_CHAIN_ID: null,
    };
}

function makeListShareCtx({ mirrorRows = [], validators = [], legStatus, coin = COIN,
                            blockIndex = 900, blockTime = 2000, startAction = 7000 } = {}){
    const state = { mirrorRows: mirrorRows.slice(), lists: new Map(), mirrors: [],
                    settlements: [], injected: [], actions: [] };
    let nextAction = startAction;
    const config = makeListShareConfig(coin);
    const indexerDb = bindMixins({
        config: config,
        mirrorDb: () => bindMixins({ doQuery: mirrorQuery(state, NETWORK) }),
        doQuery: localQuery(state),
        getList: async (index) => {
            const list = state.lists.get(Number(index));
            return list ? Array.from(list.members).sort(byBytes) : [];
        },
        getValidatorsByCapability:   async () => validators,
        getStakeWeightsByCapability: async () => validators,
        createActionIndex: async (d) => { state.actions.push(d); return nextAction++; },
    });
    const actions = {
        processTransaction: async (tx, isGenesis) => {
            state.injected.push({ tx, isGenesis });
            if(legStatus) return { ACTION_INDEX: null, STATUS: legStatus };
            return applyLeg(state, tx, nextAction++);
        },
        mapper: { createMappings: async () => {} },
    };
    const ctx = { actions, indexerDb, util: new Utility(config), mapper: { createMappings: async () => {} },
                  config, coin, network: NETWORK, blockIndex, blockTime };
    return { ctx, state };
}

module.exports = {
    NETWORK, COIN, HOME, HOME_LIST_INDEX, SNAPSHOT_BLOCK, BRIDGE_DOGE_ON_BTC, BRIDGE_LTC_ON_BTC,
    makeKey, sign, snapshotSet, makeListSnapshotRow, signListRows, makeListShareCtx,
};
