// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const { lintContractCode } = require('../../../../src/actions/deploy/lint');
const { getTestConfig } = require('../../../fixtures/config');

const NETWORK = 'testnet';
const COIN = 'BTC';
const HEIGHT = 156908;
const ACTIVATION = 1794873600;
const CODE = 'var x = /' + '('.repeat(65) + 'a' + ')'.repeat(65) + '/;';
const OLD_ERROR = 'banned literal: regex literal at line 1; regular-expression literals ' +
    'can backtrack catastrophically and are unmetered';
const NEW_ERROR = 'regex group depth exceeds limit (64) at line 1';

let XChainVM = null;
try { XChainVM = require('xchain-vm'); } catch (e) { XChainVM = null; }

let vm;
let checkExecLint;

async function deployVerdict(time) {
    const deploy = {
        config: { NETWORK, COIN },
        actions: {
            vm,
            protocolChanges: {
                isEnabled: async (name) => name === 'LINT_REGEX_GROUP_DEPTH' ? time >= ACTIVATION : true
            }
        }
    };
    const run = { code: CODE, data: { BLOCK_INDEX: HEIGHT }, error: null };
    await lintContractCode(deploy, run);
    return run.error;
}

function executeVerdict(time) {
    const gasTracker = { charge() {}, getUsed: () => 0, ceiling: 1000000 };
    const emissionCollector = { getLogs: () => [] };
    const opts = { network: NETWORK, blockContext: { timestamp: time } };
    const result = checkExecLint(vm, opts, gasTracker, emissionCollector, CODE,
        Buffer.byteLength(CODE), undefined, COIN, HEIGHT);
    return result ? result.error : null;
}

describe('DEPLOY and execute regex group-depth parity at the testnet flag day', function () {
    before(function () {
        if (!XChainVM) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('xchain-vm is not loadable');
            return this.skip();
        }
        ({ checkExecLint } = require('xchain-vm/src/index/runtime/exec_lint.js'));
        vm = new XChainVM({
            execution: 'subprocess',
            gasSchedule: getTestConfig()['GAS_SCHEDULE'],
            gasCeiling: 1000000,
            limits: {
                maxCpuTimeMs: 30000, maxMemory: 8, maxEmissions: 50,
                maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
            }
        });
    });

    after(async function () {
        if (vm) await vm.shutdown();
    });

    it('keeps the historical 65-group verdict one second before activation', async function () {
        assert.strictEqual(await deployVerdict(ACTIVATION - 1),
            'invalid: CODE_ENCODING (' + OLD_ERROR + ')');
        assert.strictEqual(executeVerdict(ACTIVATION - 1),
            'error: banned syntax: ' + OLD_ERROR);
    });

    it('pins the group-depth refusal at activation on both lint paths', async function () {
        assert.strictEqual(await deployVerdict(ACTIVATION),
            'invalid: CODE_ENCODING (' + NEW_ERROR + ')');
        assert.strictEqual(executeVerdict(ACTIVATION),
            'error: banned syntax: ' + NEW_ERROR);
    });
});
