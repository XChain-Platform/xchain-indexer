'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC, https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// The perf harness times blocks it applies through the integration launcher, so a
// throughput figure describes production's pass sequence and not a copy of it. These
// tests require the instrumented run to make exactly the calls the launcher makes, to
// report every phase the metrics collector summarises, and to leave the indexer as it
// found it.

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const launcher      = require('../../integration/setup/indexer-launcher.js');
const MetricsCollector = require('../../perf/setup/metrics-collector.js');
const { processBlocksInstrumented } = require('../../perf/setup/instrumented-processor.js');
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

// An XChainIndexer on the real prototype with every collaborator recorded, applying
// blocks 101 through `lastBlock`. testnet at a low height keeps the state roots and the
// proof-bearing reward passes below their activations.
function recordingIndexer(lastBlock, opts = {}) {
    const trace = [];
    const ix = Object.create(XChainIndexer.prototype);
    ix.trace = trace;
    ix.config = { COIN: 'BTC', NETWORK: 'testnet', GENESIS_BLOCK: -1 };
    ix.util = recorder('util', trace, {}, ['logError', 'resetLists', 'addAddressTicker', 'getAddressesList', 'getTickersList']);
    ix.indexerDb = recorder('db', trace, {
        mirrorDb: 'self', getLastProcessedReorgId: 0, getBlockIndex: null, createActionIndex: 1,
        createBlock: (block) => {
            if (opts.throwAtBlock === block) throw new Error('boom at ' + block);
            return [];
        },
    }, ['mirrorDb']);
    ix.decoderDb = {
        async getReorgsSince() { trace.push('decoder.getReorgsSince'); return []; },
        async getBlockIndex(which, pos) { trace.push('decoder.getBlockIndex'); return pos === 'last' ? lastBlock : 101; },
        async getDecoderBlockData(block) { trace.push('decoder.getDecoderBlockData'); return [{ tx_hash: 'tx' + block, data: 'SEND|X' }]; },
        async getBlockTime() { trace.push('decoder.getBlockTime'); return 1700000000; },
        async getRawBlockTime() { trace.push('decoder.getRawBlockTime'); return 1700000007; },
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
    return ix;
}

// The own methods of the indexer and the collaborators the harness instruments. Data
// fields are left out: production's openBlockTransaction stamps them on indexerDb.
function ownShape(ix) {
    const own = (o) => Object.getOwnPropertyNames(o).filter((k) => typeof o[k] === 'function').sort();
    return { indexer: own(ix), decoderDb: own(ix.decoderDb), indexerDb: own(ix.indexerDb), util: own(ix.util) };
}

// The phase names MetricsCollector reports, read from a collector's own summary.
function collectorPhaseNames() {
    const c = new MetricsCollector({ name: 'names' });
    c.start();
    c.stop();
    return Object.keys(c.getStats().phaseTiming);
}

describe('perf harness: instrumented blocks run through the integration launcher', function () {
    it('makes exactly the calls the launcher makes, block for block', async function () {
        const plain = recordingIndexer(102);
        const plainBlocks = await launcher.processBlocks(plain);

        const timed = recordingIndexer(102);
        const collector = new MetricsCollector({ name: 'trace' });
        collector.start();
        const { blocksProcessed } = await processBlocksInstrumented(timed, collector);
        collector.stop();

        assert.strictEqual(plainBlocks, 2);
        assert.strictEqual(blocksProcessed, plainBlocks);
        assert.deepStrictEqual(timed.trace, plain.trace);
        assert.ok(timed.trace.includes('util.processAttestationResponses'),
            'the cross-chain group ran, so the run is production\'s sequence and not a subset');
    });

    it('times every collector phase, every pass group and finalizeBlock for each block', async function () {
        const ix = recordingIndexer(102);
        const collector = new MetricsCollector({ name: 'phases' });
        collector.start();
        await processBlocksInstrumented(ix, collector);
        collector.stop();

        assert.deepStrictEqual(collector.blockTimings.map((b) => b.blockIndex), [101, 102]);
        const expected = collectorPhaseNames().concat(launcher.PASS_GROUPS, ['finalizeBlock']);
        for (const { blockIndex, phases } of collector.blockTimings) {
            for (const name of expected)
                assert.ok(typeof phases[name] === 'number' && phases[name] >= 0,
                    'block ' + blockIndex + ' has no timing for ' + name + ': ' + JSON.stringify(phases));
        }
        assert.deepStrictEqual(collector.errors, []);
    });

    it('leaves the indexer and its collaborators without any instrumentation afterwards', async function () {
        const ix = recordingIndexer(101);
        const before = ownShape(ix);
        const collector = new MetricsCollector({ name: 'restore' });
        collector.start();
        await processBlocksInstrumented(ix, collector);
        collector.stop();
        assert.deepStrictEqual(ownShape(ix), before);
    });

    it('records the failing block, rethrows, and still removes its wrappers', async function () {
        const ix = recordingIndexer(102, { throwAtBlock: 102 });
        const before = ownShape(ix);
        const collector = new MetricsCollector({ name: 'error' });
        collector.start();
        await assert.rejects(() => processBlocksInstrumented(ix, collector), /boom at 102/);
        collector.stop();

        assert.deepStrictEqual(collector.blockTimings.map((b) => b.blockIndex), [101]);
        assert.deepStrictEqual(collector.errors, [{ blockIndex: 102, message: 'boom at 102' }]);
        assert.ok(ix.trace.includes('db.rollbackTransaction'));
        assert.deepStrictEqual(ownShape(ix), before);
    });
});
