'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const rt     = require('../../../src/actions/actions_class/vm_runtime.js');

const pins = rt.CONSENSUS_DEPENDENCIES;
const exact = (name) => pins[name];

describe('assertConsensusDependencies', () => {
    it('is exported as a function', () => {
        assert.strictEqual(typeof rt.assertConsensusDependencies, 'function');
    });

    it('passes when every dependency is on its pin', () => {
        assert.doesNotThrow(() => rt.assertConsensusDependencies({}, exact));
    });

    it('skips when the VM failed to load (another gate owns that refusal)', () => {
        assert.doesNotThrow(() => rt.assertConsensusDependencies(null, () => null));
    });

    it('refuses a drifted version and names it', () => {
        const resolve = (n) => n === 'mathjs' ? '15.2.1' : pins[n];
        assert.throws(() => rt.assertConsensusDependencies({}, resolve),
            /CONSENSUS DEPENDENCY MISMATCH: mathjs "15.2.1" \(expected "15.2.0"\)/);
    });

    it('refuses a missing dependency instead of skipping it', () => {
        assert.throws(() => rt.assertConsensusDependencies({}, () => null),
            /acorn not installed.*mathjs not installed.*decimal\.js not installed/);
    });

    it('has no bypass: env flags do not change the outcome', () => {
        process.env.XCHAIN_SKIP_DEPENDENCY_CHECK = '1';
        try {
            assert.throws(() => rt.assertConsensusDependencies({}, () => '0.0.0'));
        } finally {
            delete process.env.XCHAIN_SKIP_DEPENDENCY_CHECK;
        }
    });

    it('keeps package.json exact pins in step with CONSENSUS_DEPENDENCIES', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
        assert.strictEqual(pkg.dependencies.acorn, pins.acorn);
        assert.strictEqual(pkg.dependencies.mathjs, pins.mathjs);
        assert.strictEqual(pkg.overrides.mathjs, pins.mathjs);
        assert.strictEqual(pkg.overrides['decimal.js'], pins['decimal.js']);
    });
});
