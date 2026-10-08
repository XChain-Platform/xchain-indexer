/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

// bin/ci_shard.js splits the ci chain's main mocha step across processes. What
// must never happen is a test file that the plain `npm run ci` runs and no shard
// does, so the file list is checked against an independent listing of the same
// globs, and the dealing is checked to be an exact partition at every count.

const assert = require('assert');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const path = require('path');

const {
    splitChain, words, shardCount, shardJobs, dealShards, partitionError, shardArgs, collectMain, runShards, exitOf,
} = require('../../../bin/ci_shard.js');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CI = require(path.join(REPO, 'package.json')).scripts.ci;

/** A spawn stand-in whose nth child prints out-<n> and closes with outcomes[n] ([code, signal]). */
function fakeSpawn(outcomes) {
    let n = 0;
    return () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        const [code, signal] = outcomes[n];
        const tag = `out-${n}\n`;
        n += 1;
        setImmediate(() => { child.stdout.emit('data', tag); child.emit('close', code, signal); });
        return child;
    };
}

/** @returns {Promise<{value: *, text: string}>} what fn resolved to and everything it printed. */
async function captured(fn) {
    const printed = [];
    const write = process.stdout.write;
    const log = console.log;
    process.stdout.write = (s) => { printed.push(String(s)); return true; };
    console.log = (s) => printed.push(`${s}\n`);
    try {
        return { value: await fn(), text: printed.join('') };
    } finally {
        process.stdout.write = write;
        console.log = log;
    }
}

describe('bin/ci_shard: the chain and its files', function(){

    it('finds exactly one main mocha step in the ci chain and keeps every other step in order', function(){
        const chain = splitChain(CI);
        assert.ok(chain, 'the ci script has one main mocha step');
        assert.strictEqual([...chain.before, chain.main, ...chain.after].join(' && '), CI);
    });

    it('refuses a chain with no mocha step or with two', function(){
        assert.strictEqual(splitChain('npm run a && npm run b'), null);
        assert.strictEqual(splitChain("mocha 'a/*.js' && mocha 'b/*.js'"), null);
    });

    it('collects every tracked file the main step globs name, once each', function(){
        const { files } = collectMain(splitChain(CI).main, REPO);
        const listed = execFileSync('git', ['-C', REPO, 'ls-files', 'test/unit', 'test/regression', 'test/security'],
            { encoding: 'utf8' }).split('\n')
            .filter((f) => f.endsWith('.test.js') && !f.split('/').some((part) => part.startsWith('.')));
        const collected = new Set(files);
        assert.strictEqual(collected.size, files.length, 'no file collected twice');
        assert.deepStrictEqual(listed.filter((f) => !collected.has(f)), [], 'a tracked test file no shard would run');
    });

    it('deals an exact partition of the collected files at every shard count', function(){
        const { files } = collectMain(splitChain(CI).main, REPO);
        for (let n = 1; n <= 16; n += 1) {
            const shards = dealShards(files, n);
            assert.strictEqual(partitionError(files, shards), null, `${n} shards`);
            assert.ok(shards.every((s) => s.length > 0), `${n} shards: an empty shard`);
        }
    });

    it('names a dropped, doubled or stray file', function(){
        assert.match(partitionError(['a', 'b'], [['a']]), /dealt 1 of 2/);
        assert.match(partitionError(['a', 'b'], [['a'], ['a']]), /twice/);
        assert.match(partitionError(['a', 'b'], [['a'], ['c']]), /did not collect: c/);
    });

});

describe('bin/ci_shard: options and runs', function(){

    it('repeats the options the step ran with, and drops mocha defaults', function(){
        const args = shardArgs({ _: ['x'], timeout: '30000', recursive: true, exit: true, require: ['a.js', 'b.js'],
            reporter: 'spec', config: false, watchIgnore: ['n'] }, { reporter: 'spec', timeout: 2000 });
        assert.deepStrictEqual(args, ['--no-config', '--no-package', '--timeout', '30000', '--recursive', '--exit',
            '--require', 'a.js', '--require', 'b.js']);
        const real = collectMain(splitChain(CI).main, REPO).args;
        assert.ok(real.includes('--timeout') && real.includes('--exit'), real.join(' '));
    });

    it('reads quoted globs as single words', function(){
        assert.deepStrictEqual(words("mocha --timeout 5 'test/a b/*.js' x"), ['mocha', '--timeout', '5', 'test/a b/*.js', 'x']);
    });

    it('takes CI_SHARDS when sane and otherwise bounds shards by cores and file count', function(){
        assert.strictEqual(shardCount({ CI_SHARDS: '3' }, 32), 3);
        assert.strictEqual(shardCount({ CI_SHARDS: '0' }, 32), 4);
        assert.strictEqual(shardCount({ CI_SHARDS: 'lots' }, 2), 1);
        assert.strictEqual(shardCount({}, 6), 3);
        assert.strictEqual(shardCount({}, 8, 1220), 13);
        assert.strictEqual(shardCount({}, 8, 2000), 16);
    });

    it('caps concurrent shard jobs by available memory or an explicit override', function(){
        const GiB = 1024 ** 3;
        assert.strictEqual(shardJobs({}, 4, GiB / 2), 1);
        assert.strictEqual(shardJobs({}, 4, 3 * GiB), 3);
        assert.strictEqual(shardJobs({}, 8, 8 * GiB), 4);
        assert.strictEqual(shardJobs({ CI_SHARD_JOBS: '2' }, 4, GiB / 2), 2);
        assert.strictEqual(shardJobs({ CI_SHARD_JOBS: '8' }, 3, GiB / 2), 3);
    });

    it('fails the run when any shard fails or dies on a signal, and prints every shard', async function(){
        const spawnShard = fakeSpawn([[0, null], [1, null], [null, 'SIGKILL']]);
        const { value, text } = await captured(() => runShards([['a'], ['b'], ['c']], [], {}, spawnShard));
        assert.strictEqual(value, false);
        for (const tag of ['out-0', 'out-1', 'out-2', 'shard 1/3 PASS', 'shard 2/3 FAIL', 'shard 3/3 FAIL']) {
            assert.ok(text.includes(tag), tag);
        }
    });

    it('passes the run only when every shard passed', async function(){
        const { value } = await captured(() => runShards([['a'], ['b']], [], {}, fakeSpawn([[0, null], [0, null]])));
        assert.strictEqual(value, true);
    });

    it('does not exceed the requested shard concurrency', async function(){
        let active = 0;
        let peak = 0;
        const spawnShard = () => {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            active += 1;
            peak = Math.max(peak, active);
            setImmediate(() => { active -= 1; child.emit('close', 0, null); });
            return child;
        };
        const { value } = await captured(() => runShards([['a'], ['b'], ['c'], ['d']], [], {}, spawnShard, 2));
        assert.strictEqual(value, true);
        assert.strictEqual(peak, 2);
    });

    // Review finding (machine session 9): an npm that cannot start or dies on a
    // signal has a null status, which must never become a green exit.
    it('reads an unsharded run with no exit status as red', function(){
        assert.strictEqual(exitOf({ status: 0 }), 0);
        assert.strictEqual(exitOf({ status: 3 }), 3);
        assert.strictEqual(exitOf({ status: null, signal: 'SIGKILL' }), 1);
        assert.strictEqual(exitOf({ status: null, error: new Error('spawn npm ENOENT') }), 1);
    });
});
