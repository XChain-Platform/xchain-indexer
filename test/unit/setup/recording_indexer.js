'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const XChainIndexer = require('../../../src/XChainIndexer.js');

const BLOCK_TIME     = 1700000000;
const RAW_BLOCK_TIME = 1700000007;

function recorder(label, trace, answers = {}, sync = []) {
    const proxy = new Proxy({}, {
        get(target, prop) {
            if (typeof prop !== 'string' || prop === 'then') return undefined;
            if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
            return (...args) => {
                trace.push(label + '.' + prop);
                const answer = Object.prototype.hasOwnProperty.call(answers, prop) ? answers[prop] : [];
                const out = answer === 'self' ? proxy : (typeof answer === 'function' ? answer(...args) : answer);
                return sync.includes(prop) ? out : Promise.resolve(out);
            };
        },
        set(target, prop, value) { target[prop] = value; return true; },
    });
    return proxy;
}

function recordingIndexer(opts) {
    const {
        firstBlock,
        lastBlock = firstBlock,
        traceDecoderCalls = false,
        recordCreateBlockArgs = false,
        throwInCreateBlock = false,
        throwAtBlock,
        createBlockError = (block) => 'boom at ' + block,
        noVm = false,
        passGroups = [],
    } = opts;
    const trace = [];
    const ix = Object.create(XChainIndexer.prototype);
    ix.trace = trace;
    ix.config = { COIN: 'BTC', NETWORK: 'testnet', GENESIS_BLOCK: -1 };
    ix.util = recorder('util', trace, {}, ['logError', 'resetLists', 'addAddressTicker', 'getAddressesList', 'getTickersList']);
    ix.indexerDb = recorder('db', trace, {
        mirrorDb: 'self',
        getLastProcessedReorgId: 0,
        getBlockIndex: null,
        createActionIndex: 1,
        createBlock: (block, rawBlockTime) => {
            if (recordCreateBlockArgs) trace.push('createBlock@' + block + '/' + rawBlockTime);
            if (throwInCreateBlock || throwAtBlock === block) throw new Error(createBlockError(block));
            return [];
        },
    }, ['mirrorDb']);
    const decoderTrace = (method) => {
        if (traceDecoderCalls) trace.push('decoder.' + method);
    };
    ix.decoderDb = {
        async getReorgsSince() { decoderTrace('getReorgsSince'); return []; },
        async getBlockIndex(which, pos) {
            decoderTrace('getBlockIndex');
            return pos === 'last' ? lastBlock : firstBlock;
        },
        async getDecoderBlockData(block) {
            decoderTrace('getDecoderBlockData');
            return [{ tx_hash: 'tx' + block, data: 'SEND|X' }];
        },
        async getBlockTime() { decoderTrace('getBlockTime'); return BLOCK_TIME; },
        async getRawBlockTime() { decoderTrace('getRawBlockTime'); return RAW_BLOCK_TIME; },
    };
    ix.protocolChanges = { async isEnabled() { return true; } };
    ix.actions = {
        vm: noVm ? null : {
            beginBlock() { trace.push('vm.beginBlock'); },
            endBlock() { trace.push('vm.endBlock'); },
        },
        async processTransaction() { trace.push('actions.processTransaction'); },
    };
    ix.genesis = recorder('genesis', trace, { gasTokenParams: {} }, ['gasTokenParams']);
    ix.mapper = recorder('mapper', trace);
    ix.anchorProof = recorder('anchorProof', trace);
    ix.rollcallProof = recorder('rollcallProof', trace);
    for (const name of passGroups) {
        const pass = XChainIndexer.prototype[name];
        ix[name] = async function (blk) {
            trace.push('<' + name);
            await pass.call(this, blk);
            trace.push(name + '>');
        };
    }
    return ix;
}

module.exports = { BLOCK_TIME, RAW_BLOCK_TIME, recordingIndexer };
