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
const tickerQueries = require('../../../../src/db/index_tables/tickers.js');
const tickCoin = require('../../../../src/actions/list/tick_coin.js');
const { listItemId } = require('../../../../src/db/lists/membership.js');
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
        if(sql === 'SELECT id FROM index_tickers WHERE tick=? LIMIT 1'){
            const row = state.tickers.find((candidate) => candidate.tick === args[0]);
            return row ? [{ id: row.id }] : [];
        }
        if(sql === 'SELECT id FROM index_tickers WHERE LOWER(tick)=? ORDER BY id ASC LIMIT 1'){
            const rows = state.tickers
                .filter((candidate) => candidate.tick.toLowerCase() === args[0])
                .sort((left, right) => left.id - right.id);
            return rows.length ? [{ id: rows[0].id }] : [];
        }
        if(sql === 'SELECT id FROM index_tickers ORDER BY id DESC LIMIT 1 FOR UPDATE'){
            const rows = state.tickers.slice().sort((left, right) => right.id - left.id);
            return rows.length ? [{ id: rows[0].id }] : [];
        }
        if(sql === 'INSERT IGNORE INTO index_tickers (`id`, `tick`, `block_index`) values (?, ?, ?)'){
            if(!state.tickers.some((candidate) => candidate.tick === args[1]))
                state.tickers.push({ id: args[0], tick: args[1], block_index: args[2] });
            return { affectedRows: 1 };
        }
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

async function tickerItem(state, db, config, item, data){
    const checked = await tickCoin.checkTickItem.call({ indexerDb: db, config }, item, data);
    if(checked.status !== 'valid') return null;
    return listItemId(db, 1, checked.item);
}

async function applyLeg(state, db, config, tx, nextAction, isGenesis){
    const f = tx.data.split('|');
    if(f[0] !== 'LIST') return { ACTION_INDEX: nextAction, STATUS: 'valid' };
    const data = {
        BLOCK_INDEX: tx.block_index,
        IS_GENESIS: isGenesis,
        SOURCE: tx.source,
    };
    if(f[1] === '0'){
        const type = Number(f[2]);
        const members = new Set();
        for(const item of f.slice(4)){
            const stored = state.tickerMode && type === 1
                ? await tickerItem(state, db, config, item, data)
                : item;
            if(stored !== null) members.add(stored);
        }
        state.lists.set(nextAction, { type, owner: tx.source, members });
        return { ACTION_INDEX: nextAction, STATUS: 'valid' };
    }
    const list = state.lists.get(Number(f[3]));
    if(!list) return { ACTION_INDEX: nextAction, STATUS: 'invalid: LIST_ACTION_INDEX (unknown)' };
    for(const item of f.slice(5)){
        const stored = state.tickerMode && list.type === 1
            ? await tickerItem(state, db, config, item, data)
            : item;
        if(stored === null) continue;
        if(f[2] === '1') list.members.add(stored);
        else list.members.delete(stored);
    }
    return { ACTION_INDEX: nextAction, STATUS: 'valid' };
}

function makeListShareConfig(coin){
    return {
        COIN: coin, NETWORK: NETWORK, COINS: ['BTC', 'LTC', 'DOGE'],
        ADDRESS: { BRIDGE_DOGE: BRIDGE_DOGE_ON_BTC, BRIDGE_LTC: BRIDGE_LTC_ON_BTC },
        MIN_TICK_LENGTH: 1,
        MAX_TICK_LENGTH: 20,
        TICK_CHARACTERS: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        BTC_CHAIN_ID: null,
    };
}

function makeListShareCtx({ mirrorRows = [], validators = [], legStatus, coin = COIN,
                            blockIndex = 900, blockTime = 2000, startAction = 7000,
                            tickerRows } = {}){
    const state = { mirrorRows: mirrorRows.slice(), lists: new Map(), mirrors: [],
                    settlements: [], injected: [], actions: [], tokenInfoCalls: [],
                    tickerMode: Array.isArray(tickerRows),
                    tickers: (tickerRows || []).map((row, index) => typeof row === 'string'
                        ? { id: index + 1, tick: row, block_index: blockIndex - 1 }
                        : Object.assign({}, row)) };
    let nextAction = startAction;
    const config = makeListShareConfig(coin);
    const util = new Utility(config);
    const indexerDb = bindMixins({
        config: config,
        util,
        mirrorDb: () => bindMixins({ doQuery: mirrorQuery(state, NETWORK), doQueryStrict: mirrorQuery(state, NETWORK) }),
        doQuery: localQuery(state),
        getList: async (index) => {
            const list = state.lists.get(Number(index));
            if(!list) return [];
            const members = Array.from(list.members);
            if(state.tickerMode && list.type === 1)
                return members.map((id) => state.tickers.find((row) => row.id === id).tick).sort(byBytes);
            return members.sort(byBytes);
        },
        getTokenInfo: async (item) => { state.tokenInfoCalls.push(item); return null; },
        getValidatorsByCapability:   async () => validators,
        getStakeWeightsByCapability: async () => validators,
        createActionIndex: async (d) => { state.actions.push(d); return nextAction++; },
    });
    // No list carries metadata unless a test says so; the apply path reads it per list.
    indexerDb.getListMeta = async () => null;
    if(state.tickerMode){
        Object.assign(indexerDb, tickerQueries);
        indexerDb.blockIndex = blockIndex;
        indexerDb.transactionConnection = { id: 1 };
        indexerDb.suppressIndexIdCreation = false;
        indexerDb.deterministicIndexingStarted = true;
        indexerDb._internCache = null;
    }
    const actions = {
        processTransaction: async (tx, isGenesis) => {
            state.injected.push({ tx, isGenesis });
            if(legStatus) return { ACTION_INDEX: null, STATUS: legStatus };
            return applyLeg(state, indexerDb, config, tx, nextAction++, isGenesis);
        },
        mapper: { createMappings: async () => {} },
    };
    const ctx = { actions, indexerDb, util, mapper: { createMappings: async () => {} },
                  config, coin, network: NETWORK, blockIndex, blockTime };
    return { ctx, state };
}

module.exports = {
    NETWORK, COIN, HOME, HOME_LIST_INDEX, SNAPSHOT_BLOCK, BRIDGE_DOGE_ON_BTC, BRIDGE_LTC_ON_BTC,
    makeKey, sign, snapshotSet, makeListSnapshotRow, signListRows, makeListShareCtx,
};
