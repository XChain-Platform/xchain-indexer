'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// The per-block VM compilation cache as the integration launcher runs it through
// production's block passes. A contract compiled outside the cache window, or a cache
// that survives into the next block, executes on a rhythm the fleet never runs. These
// tests pin where the window opens and closes relative to the pass groups, and what a
// block that throws inside the window leaves behind.

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const launcher      = require('../../integration/setup/indexer-launcher.js');
const XChainIndexer = require('../../../src/XChainIndexer.js');

// A collaborator whose every method call is appended to `trace` as `<label>.<method>`.
// `answers` maps a method to its return value ('self' returns the collaborator), and
// `sync` names the methods production calls without awaiting.
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

// An XChainIndexer on the real prototype with every collaborator recorded and each pass
// group bracketed by markers. testnet at a low height keeps the state roots and the
// proof-bearing reward passes below their activations.
function recordingIndexer(firstBlock, lastBlock) {
    const trace = [];
    const ix = Object.create(XChainIndexer.prototype);
    ix.trace = trace;
    ix.config = { COIN: 'BTC', NETWORK: 'testnet', GENESIS_BLOCK: -1 };
    ix.util = recorder('util', trace, {}, ['logError', 'resetLists', 'addAddressTicker', 'getAddressesList', 'getTickersList']);
    ix.indexerDb = recorder('db', trace, {
        mirrorDb: 'self', getLastProcessedReorgId: 0, getBlockIndex: null, createActionIndex: 1,
    }, ['mirrorDb']);
    ix.decoderDb = {
        async getReorgsSince() { return []; },
        async getBlockIndex(which, pos) { return pos === 'last' ? lastBlock : firstBlock; },
        async getDecoderBlockData(block) { return [{ tx_hash: 'tx' + block, data: 'SEND|X' }]; },
        async getBlockTime() { return 1700000000; },
        async getRawBlockTime() { return 1700000007; },
    };
    ix.protocolChanges = { async isEnabled() { return true; } };
    ix.actions = {
        vm: { beginBlock() { trace.push('vm.beginBlock'); }, endBlock() { trace.push('vm.endBlock'); } },
        async processTransaction() { trace.push('actions.processTransaction'); },
    };
    ix.genesis = recorder('genesis', trace, { gasTokenParams: {} }, ['gasTokenParams']);
    ix.mapper = recorder('mapper', trace);
    ix.anchorProof = recorder('anchorProof', trace);
    ix.rollcallProof = recorder('rollcallProof', trace);
    for (const name of launcher.PASS_GROUPS) {
        const pass = XChainIndexer.prototype[name];
        ix[name] = async function (blk) {
            trace.push('<' + name);
            await pass.call(this, blk);
            trace.push(name + '>');
        };
    }
    return ix;
}

const isMarker = (entry) => entry.startsWith('<') || entry.endsWith('>');

describe('integration harness VM block rhythm through production\'s passes', function () {
    it('opens the cache first inside the block and closes it after every pass group, just before createBlock', async function () {
        const ix = recordingIndexer(101, 101);
        assert.strictEqual(await launcher.processBlocks(ix), 1);
        const t = ix.trace.slice(ix.trace.indexOf('db.beginTransaction'));
        const groups = launcher.PASS_GROUPS;

        // The cache is the first thing the block does after its transaction opens,
        // ahead of the genesis injection and every transaction in the first group.
        assert.deepStrictEqual(t.slice(0, 3), ['db.beginTransaction', '<' + groups[0], 'vm.beginBlock']);

        // Every pass group runs entirely inside the window, so every contract the block
        // executes compiles against this block's cache.
        const open = t.indexOf('vm.beginBlock');
        const close = t.indexOf('vm.endBlock');
        assert.ok(t.indexOf('actions.processTransaction') > open);
        for (const name of groups.slice(1))
            assert.ok(t.indexOf('<' + name) > open, name + ' started before the cache opened');
        for (const name of groups)
            assert.ok(t.indexOf(name + '>') < close, name + ' finished after the cache closed');

        // Nothing between the window closing and the commit can execute contract code,
        // and the blocks row is the next write.
        const after = t.slice(close + 1).filter((entry) => !isMarker(entry));
        assert.strictEqual(after[0], 'db.createBlock');
        assert.ok(!after.some((entry) => entry.startsWith('actions.') || entry.startsWith('vm.')),
            'a VM-reachable call ran after the cache closed: ' + JSON.stringify(after));
        assert.strictEqual(after[after.length - 1], 'db.commitTransaction');
    });

    it('leaves the cache open when a pass throws inside the window, and the next attempt opens a fresh one', async function () {
        const ix = recordingIndexer(101, 101);
        let failures = 1;
        ix.util.processCrossChainCalls = async function () {
            ix.trace.push('util.processCrossChainCalls');
            if (failures-- > 0) throw new Error('mid-pass');
        };

        // Production's abandonBlock rolls back without closing the cache; the launcher
        // rethrows the same way and writes no blocks row.
        await assert.rejects(() => launcher.processBlocks(ix), /mid-pass/);
        const rhythm = (trace) => trace.filter((c) => c.startsWith('vm.') || c === 'db.createBlock' ||
                                                     c === 'db.rollbackTransaction' || c === 'db.commitTransaction');
        assert.deepStrictEqual(rhythm(ix.trace), ['vm.beginBlock', 'db.rollbackTransaction']);

        // The retry of the same block installs a new cache before any of its work and
        // closes it before the blocks row, as every block does.
        const mark = ix.trace.length;
        assert.strictEqual(await launcher.processBlocks(ix), 1);
        assert.deepStrictEqual(rhythm(ix.trace.slice(mark)),
            ['vm.beginBlock', 'vm.endBlock', 'db.createBlock', 'db.commitTransaction']);
    });
});
