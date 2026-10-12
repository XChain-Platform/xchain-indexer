'use strict';

const assert = require('assert');
const rt     = require('../../../src/actions/actions_class/vm_runtime.js');

describe('assertConsensusDependencies', () => {
    it('is exported as a function', () => {
        assert.strictEqual(typeof rt.assertConsensusDependencies, 'function');
    });

    it('passes only the VM-owned dependency result', () => {
        let calls = 0;
        const vm = {
            checkConsensusDependencies: () => {
                calls += 1;
                return { ok: true, mismatches: [] };
            },
            describeDependencyMismatch: () => 'not used'
        };
        assert.doesNotThrow(() => rt.assertConsensusDependencies(vm));
        assert.strictEqual(calls, 1);
    });

    it('fails closed when the VM dependency checker is unavailable', () => {
        assert.throws(() => rt.assertConsensusDependencies(null),
            /CONSENSUS DEPENDENCY CHECK UNAVAILABLE/);
        assert.throws(() => rt.assertConsensusDependencies({}),
            /CONSENSUS DEPENDENCY CHECK UNAVAILABLE/);
    });

    it('refuses the mismatch with the VM-owned diagnostic', () => {
        const result = {
            ok: false,
            mismatches: [{ key: 'decimal.js', expected: '10.4.3', actual: undefined }]
        };
        const vm = {
            checkConsensusDependencies: () => result,
            describeDependencyMismatch: (actual) => {
                assert.strictEqual(actual, result);
                return 'CONSENSUS DEPENDENCY MISMATCH: decimal.js missing';
            }
        };
        assert.throws(() => rt.assertConsensusDependencies(vm),
            /CONSENSUS DEPENDENCY MISMATCH: decimal\.js missing/);
    });

    it('has no bypass: env flags do not change the outcome', () => {
        const vm = {
            checkConsensusDependencies: () => ({ ok: false, mismatches: [] }),
            describeDependencyMismatch: () => 'CONSENSUS DEPENDENCY MISMATCH'
        };
        process.env.XCHAIN_SKIP_DEPENDENCY_CHECK = '1';
        try {
            assert.throws(() => rt.assertConsensusDependencies(vm),
                /CONSENSUS DEPENDENCY MISMATCH/);
        } finally {
            delete process.env.XCHAIN_SKIP_DEPENDENCY_CHECK;
        }
    });

    it('runs after the epoch gate and before VM construction', () => {
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(path.join(__dirname, '../../../src/actions/index.js'), 'utf8');
        const epoch = source.indexOf('assertVmConsensusEpoch(XChainVM);');
        const dependencies = source.indexOf('assertConsensusDependencies(XChainVM);');
        const construction = source.indexOf('new XChainVM(vmOptions(this.config))');
        assert(epoch >= 0 && epoch < dependencies);
        assert(dependencies < construction);
    });
});
