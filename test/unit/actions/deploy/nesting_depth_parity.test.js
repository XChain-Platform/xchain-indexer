'use strict';

// Deploy lint and the execute-time lint must give the same nesting verdict at a
// testnet height where the nesting gate is armed: a 65-deep source with no
// initialize is refused by both with 'nesting depth exceeds limit (64)', and a
// 64-deep source passes both. If the two paths disagreed, a contract could be
// accepted at deploy and then refused on every call (or the reverse).

const assert = require('assert');

const { lintContractCode } = require('../../../../src/actions/deploy/lint');
const gateRegistry = require('../../../../src/consensus/gate_registry');
const { getTestConfig } = require('../../../fixtures/config');

const NETWORK = 'testnet';
const COIN = 'BTC';
// BTC:testnet height of VM_LINT_NESTING_DEPTH_ACTIVATION (protocol_changes/gates_4.js).
const HEIGHT = 156230;
const NESTING_REFUSAL = 'nesting depth exceeds limit (64)';

// A top-level array literal nested n deep, with no initialize export.
function nestedSource(depth) {
    return 'var x = ' + '['.repeat(depth) + ']'.repeat(depth) + ';\n';
}

let XChainVM = null;
try { XChainVM = require('xchain-vm'); } catch (e) { XChainVM = null; }

let vm = null;
let checkExecLint = null;

// The deploy path: lintContractCode resolves its flags from this block's
// gates and runs the VM's validateSyntax over the source.
async function deployVerdict(code) {
    const deploy = {
        config: { NETWORK, COIN },
        actions: { vm, protocolChanges: { isEnabled: async () => true } },
    };
    const run = { code, data: { BLOCK_INDEX: HEIGHT }, error: null };
    await lintContractCode(deploy, run);
    return run.error;
}

// The execute path: checkExecLint re-lints the stored code through
// vm.getLintVerdict with the flags the VM resolves for this block.
function executeVerdict(code) {
    const gasTracker = { charge() {}, getUsed: () => 0, ceiling: 1000000 };
    const emissionCollector = { getLogs: () => [] };
    const opts = { network: NETWORK, blockContext: { timestamp: Math.floor(Date.now() / 1000) } };
    const result = checkExecLint(vm, opts, gasTracker, emissionCollector, code,
        Buffer.byteLength(code), undefined, COIN, HEIGHT);
    return result ? result.error : null;
}

describe('DEPLOY and execute nesting-depth parity at BTC:testnet 156230', function () {
    before(function () {
        if (!XChainVM) {
            // The vendored VM is untracked; a tree without it cannot run this parity check.
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('xchain-vm is not loadable');
            return this.skip();
        }
        ({ checkExecLint } = require('xchain-vm/src/index/runtime/exec_lint.js'));
        vm = new XChainVM({
            execution: 'subprocess',
            gasSchedule: getTestConfig()['GAS_SCHEDULE'],
            gasCeiling: 1000000,
            limits: { maxCpuTimeMs: 30000, maxMemory: 8, maxEmissions: 50,
                      maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536 },
        });
    });

    it('arms the deploy nesting gate at 156230 and not one block below', function () {
        const gate = 'vm_lint_nesting_depth_activation.VM_LINT_NESTING_DEPTH_ACTIVATION';
        assert.strictEqual(gateRegistry.activeAt(gate, NETWORK, COIN, HEIGHT, null), true);
        assert.strictEqual(gateRegistry.activeAt(gate, NETWORK, COIN, HEIGHT - 1, null), false);
    });

    it('refuses a 65-deep source on deploy and on getLintVerdict with the same reason', async function () {
        const code = nestedSource(65);
        const deployError = await deployVerdict(code);
        const executeError = executeVerdict(code);

        assert.ok(deployError && deployError.includes(NESTING_REFUSAL), 'deploy: ' + deployError);
        assert.ok(executeError && executeError.includes(NESTING_REFUSAL), 'execute: ' + executeError);
        assert.strictEqual(deployError, 'invalid: CODE_ENCODING (' + NESTING_REFUSAL + ' at line 1)');
        assert.strictEqual(executeError, 'error: banned syntax: ' + NESTING_REFUSAL + ' at line 1');
    });

    it('accepts a 64-deep source on deploy and on getLintVerdict', async function () {
        const code = nestedSource(64);
        assert.strictEqual(await deployVerdict(code), null);
        assert.strictEqual(executeVerdict(code), null);
    });
});
