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

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

describe('Security: database name validation @regression @tier4', function () {
    const validNamePattern = /^[A-Za-z0-9_]+$/;

    it('SEC-37: database name \'XChain_BTC_Regtest_Indexer\' → valid', function () {
        assert.strictEqual(validNamePattern.test('XChain_BTC_Regtest_Indexer'), true);
    });

    it('SEC-38: database name with spaces → rejected', function () {
        assert.strictEqual(validNamePattern.test('XChain Indexer'), false);
    });

    it('SEC-39: database name with SQL injection chars → rejected', function () {
        assert.strictEqual(validNamePattern.test('XChain; DROP TABLE--'), false);
    });

    it('SEC-40: database name with backticks → rejected', function () {
        assert.strictEqual(validNamePattern.test('XChain`Indexer'), false);
    });

    it('SEC-39b: database name with parentheses → rejected', function () {
        assert.strictEqual(validNamePattern.test('XChain()'), false);
    });

    it('SEC-39c: database name with quotes → rejected', function () {
        assert.strictEqual(validNamePattern.test("XChain'Indexer"), false);
    });
});

describe('Security: connection pool timeout configuration @regression @tier4', function () {
    const Database = require('../../../../src/db.js');
    const { createMockIndexer } = require('../../../fixtures/mocks');

    function makeDb() {
        const indexer = createMockIndexer();
        return new Database('localhost', 3306, 'test_db', 'user', 'pass', indexer);
    }

    it('SEC-41: connection pool has connectTimeout set', function () {
        const db = makeDb();
        assert.strictEqual(db.connectionPoolParams.connectTimeout, 10000,
            'connectTimeout should be 10000ms');
    });

    it('SEC-42: connection pool has acquireTimeout set', function () {
        const db = makeDb();
        assert.strictEqual(db.connectionPoolParams.acquireTimeout, 10000,
            'acquireTimeout should be 10000ms');
    });

    it('SEC-42b: connection pool has idleTimeout set', function () {
        const db = makeDb();
        assert.strictEqual(db.connectionPoolParams.idleTimeout, 60000,
            'idleTimeout should be 60000ms');
    });
});

// An indexer whose isolated-vm binding cannot load must REFUSE AT BOOT, not start and
// park at the first contract block. The park is data-dependent (the first contract block,
// not the tip), so the old warn-and-continue path served a stale height hundreds of blocks
// behind the decoder before anything looked wrong, and the 503 it answered named neither
// the binding nor the platform mismatch behind it.
//
// The binding failure is simulated at the module loader: an ELF binding on a Darwin host
// (the measured case) surfaces to require('xchain-vm') as exactly this ERR_DLOPEN_FAILED,
// and reproducing it for real would need a foreign node_modules on the test host.
describe('Security: VM runtime boot refusal @regression @tier4', function () {
    const Module  = require('module');
    const Actions = require('../../../../src/actions.js');
    const { createMockIndexer } = require('../../../fixtures/mocks');

    const actionsPath = require.resolve('../../../../src/actions.js');

    function dlopenFailure() {
        const err = new Error(
            'dlopen(/srv/xchain-indexer/node_modules/isolated-vm/out/isolated_vm.node, 0x0001): ' +
            "tried: '/srv/xchain-indexer/node_modules/isolated-vm/out/isolated_vm.node' " +
            '(not a mach-o file)');
        err.code = 'ERR_DLOPEN_FAILED';
        return err;
    }

    /** Re-evaluate src/actions.js with require('xchain-vm') failing, then restore the cache. */
    function actionsWithUnloadableVm(loadError) {
        const origLoad = Module._load;
        const saved    = require.cache[actionsPath];
        delete require.cache[actionsPath];
        Module._load = function (request) {
            if (request === 'xchain-vm') throw loadError;
            return origLoad.apply(this, arguments);
        };
        try {
            return require(actionsPath);
        } finally {
            Module._load = origLoad;
            delete require.cache[actionsPath];
            if (saved) require.cache[actionsPath] = saved;   // leave the real module for later suites
        }
    }

    function mockIndexer() {
        const indexer = createMockIndexer();
        indexer.protocolChanges = { isDefined: () => true, isEnabled: async () => true };
        return indexer;
    }

    it('SEC-43: Actions construction refuses when the VM binding cannot load', function () {
        const Broken = actionsWithUnloadableVm(dlopenFailure());
        assert.throws(() => new Broken(mockIndexer()), /VM RUNTIME UNAVAILABLE/);
    });

    it('SEC-44: the refusal names the binding, its format and this host', function () {
        const Broken = actionsWithUnloadableVm(dlopenFailure());
        let message = null;
        try { new Broken(mockIndexer()); } catch (e) { message = e.message; }
        assert.ok(message, 'construction must not succeed');
        assert.ok(message.includes('isolated_vm.node'), `binding not named: ${message}`);
        assert.ok(message.includes(process.platform) && message.includes(process.arch),
            `host platform not named: ${message}`);
        assert.ok(message.includes('ERR_DLOPEN_FAILED'), `loader error not carried: ${message}`);
    });

    it('SEC-45: no Actions instance is produced with a null vm (the old silent-park state)', function () {
        const Broken = actionsWithUnloadableVm(dlopenFailure());
        let instance = null;
        try { instance = new Broken(mockIndexer()); } catch (e) { /* expected */ }
        assert.strictEqual(instance, null,
            'a constructed Actions with this.vm = null is exactly the state that parks at the first contract block');
    });

    it('SEC-46: a loadable VM still constructs (the gate does not fire on a healthy host)', function () {
        const actions = new Actions(mockIndexer());
        assert.ok(actions.vm, 'vm must be wired when xchain-vm loads');
    });
});
