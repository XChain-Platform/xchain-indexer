/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const {
    splitCommand,
    mochaArgsFor,
    compare,
    expand,
    mergeScriptMap,
} = require('../../../bin/suite-title-map.js');

function registerSplitCommandTests(){
    it('keeps quoted grep patterns and globs as single tokens', function(){
        assert.deepStrictEqual(
            splitCommand('mocha --grep "@x.*(a|b)" \'test/**/*.js\''),
            [
                { value: 'mocha', quoted: false },
                { value: '--grep', quoted: false },
                { value: '@x.*(a|b)', quoted: true },
                { value: 'test/**/*.js', quoted: true },
            ]
        );
    });
}

function registerMochaArgsForTests(){
    it('extracts leading environment assignments from mocha arguments', function(){
        assert.deepStrictEqual(
            mochaArgsFor("FUZZ_RUNS=1000 mocha --timeout 0 'test/fuzz/**/*.js'"),
            {
                args: ['--timeout', '0', 'test/fuzz/**/*.js'],
                env: { FUZZ_RUNS: '1000' },
            }
        );
    });

    it('extracts npm scripts from a composite command', function(){
        assert.deepStrictEqual(
            mochaArgsFor('npm run test:unit && npm run test:integration'),
            { composite: ['test:unit', 'test:integration'] }
        );
    });

    it('identifies a non-mocha command in the skip reason', function(){
        assert.deepStrictEqual(
            mochaArgsFor('node bin/something.js'),
            { skip: 'not a mocha command (runs node)' }
        );
    });
}

function registerCompareTitleTests(){
    it('reports dropped and added titles for an unrenamed file', function(){
        const pin = {
            titleSets: { old: ['suite old title'] },
            scripts: { test: { files: { 'test/example.test.js': 'old' } } },
        };
        const fresh = {
            titleSets: { fresh: ['suite new title'] },
            scripts: { test: { files: { 'test/example.test.js': 'fresh' } } },
        };

        assert.deepStrictEqual(compare(pin, fresh, {}), [
            {
                script: 'test',
                kind: 'title_dropped',
                file: 'test/example.test.js',
                title: 'suite old title',
            },
            {
                script: 'test',
                kind: 'title_added',
                file: 'test/example.test.js',
                title: 'suite new title',
            },
        ]);
    });

    it('accepts an identical title set moved through the rename map', function(){
        const pin = {
            titleSets: { shared: ['suite title'] },
            scripts: { test: { files: { 'test/old.test.js': 'shared' } } },
        };
        const fresh = {
            titleSets: { shared: ['suite title'] },
            scripts: { test: { files: { 'test/new.test.js': 'shared' } } },
        };

        assert.deepStrictEqual(compare(pin, fresh, {
            'test/old.test.js': 'test/new.test.js',
        }), []);
    });
}

function registerCompareFileTests(){
    it('reports files that exist on only one side', function(){
        const pin = {
            titleSets: { shared: ['shared title'], dropped: ['dropped title'] },
            scripts: {
                test: {
                    files: {
                        'test/shared.test.js': 'shared',
                        'test/dropped.test.js': 'dropped',
                    },
                },
            },
        };
        const fresh = {
            titleSets: { shared: ['shared title'], added: ['added title'] },
            scripts: {
                test: {
                    files: {
                        'test/shared.test.js': 'shared',
                        'test/added.test.js': 'added',
                    },
                },
            },
        };

        assert.deepStrictEqual(compare(pin, fresh, {}), [
            { script: 'test', kind: 'file_added', file: 'test/added.test.js' },
            { script: 'test', kind: 'file_dropped', file: 'test/dropped.test.js' },
        ]);
    });
}

function registerCompareTests(){
    registerCompareTitleTests();
    registerCompareFileTests();
}

function registerExpandTests(){
    it('returns null for an uncollected script', function(){
        assert.strictEqual(expand({ titleSets: {}, scripts: {} }, 'test:missing'), null);
    });

    it('returns the flat file-to-titles view for a collected script', function(){
        const map = {
            titleSets: {
                first: ['first title'],
                second: ['second title', 'third title'],
            },
            scripts: {
                test: {
                    files: {
                        'test/z.test.js': 'second',
                        'test/a.test.js': 'first',
                    },
                },
            },
        };

        assert.deepStrictEqual(expand(map, 'test'), {
            'test/a.test.js': ['first title'],
            'test/z.test.js': ['second title', 'third title'],
        });
    });
}

function registerMergeScriptMapTests(){
    it('refreshes one script without dropping unrelated scripts or their title sets', function(){
        const existing = {
            titleSets: {
                oldTest: ['old test title'],
                security: ['security title'],
                unused: ['no script references this'],
            },
            scripts: {
                test: { files: { 'test/unit/example.test.js': 'oldTest' } },
                'test:security': { files: { 'test/security/example.test.js': 'security' } },
            },
        };
        const fresh = {
            titleSets: { newTest: ['new test title'] },
            scripts: { test: { files: { 'test/unit/example.test.js': 'newTest' } } },
        };

        assert.deepStrictEqual(mergeScriptMap(existing, fresh, 'test'), {
            titleSets: {
                newTest: ['new test title'],
                security: ['security title'],
            },
            scripts: {
                test: { files: { 'test/unit/example.test.js': 'newTest' } },
                'test:security': { files: { 'test/security/example.test.js': 'security' } },
            },
        });
    });

    it('refuses to create a misleading partial map from a missing script', function(){
        assert.throws(
            () => mergeScriptMap({ titleSets: {}, scripts: {} }, { titleSets: {}, scripts: {} }, 'test'),
            /fresh map does not contain test/
        );
    });
}

function registerPureHelperTests(){
    describe('splitCommand', registerSplitCommandTests);
    describe('mochaArgsFor', registerMochaArgsForTests);
    describe('compare', registerCompareTests);
    describe('expand', registerExpandTests);
    describe('mergeScriptMap', registerMergeScriptMapTests);
}

describe('bin/suite-title-map pure helpers', registerPureHelperTests);
