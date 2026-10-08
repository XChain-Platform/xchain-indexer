#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 *********************************************************************/

'use strict';

// bin/ci_shard.js: the `npm run ci` chain with its main mocha step split across
// parallel processes. The main step is about six of the tier's minutes on a
// venue, one core at a time, while the venue sits mostly idle; every other step
// of the chain runs unchanged and in order.
//
// The chain is read from package.json on every run, never copied here, so a
// step added to `ci` is run by this script too. The file list is the one mocha
// itself collects for that step (its own option loader and collector, the
// .mocharc merge included), and the shards partition it: every file runs in
// exactly one shard. When that cannot be shown (mocha's collector unreadable,
// or a dealing that is not an exact partition) the step runs whole, and a
// package.json this script cannot read the same way runs the plain `npm run ci`,
// so a shape it does not know can only cost time, never tests.
//
// Usage: node bin/ci_shard.js --run|--list
// CI_SHARDS=<1..16> overrides the count; CI_SHARD_JOBS=<1..16> caps concurrency.

const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const MAIN_STEP = /^mocha\s/;
const MAX_SHARDS = 16;
const MAX_FILES_PER_SHARD = 100;

/** @returns {{before: string[], main: string, after: string[]}|null} the ci chain around its one main mocha step. */
function splitChain(ciScript) {
  const steps = String(ciScript || '').split(' && ').map((step) => step.trim());
  const mains = steps.filter((step) => MAIN_STEP.test(step));
  if (mains.length !== 1) return null;
  const at = steps.indexOf(mains[0]);
  return { before: steps.slice(0, at), main: mains[0], after: steps.slice(at + 1) };
}

/** @returns {string[]} the words of one package-script step; only single quotes are expected there. */
function words(step) {
  return [...step.matchAll(/'([^']*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
}

/** @returns {number} the shard count, bounded by CPU count and files per process. */
function shardCount(env = process.env, cpus = os.cpus().length, files = 0) {
  const asked = Number(env.CI_SHARDS);
  if (Number.isInteger(asked) && asked >= 1 && asked <= MAX_SHARDS) return asked;
  const cpuShards = Math.max(1, Math.min(4, Math.floor(cpus / 2)));
  const fileShards = Math.max(1, Math.ceil(files / MAX_FILES_PER_SHARD));
  return Math.min(MAX_SHARDS, Math.max(cpuShards, fileShards));
}

/** @returns {number} the number of shard processes allowed to run concurrently. */
function shardJobs(env = process.env, total = 1, freeMem = os.freemem()) {
  const asked = Number(env.CI_SHARD_JOBS);
  if (Number.isInteger(asked) && asked >= 1 && asked <= MAX_SHARDS) return Math.min(asked, total);
  const memoryJobs = Math.max(1, Math.floor(freeMem / (1024 ** 3)));
  return Math.min(total, memoryJobs, 4);
}

/** @returns {string[][]} files dealt round-robin, each shard keeping mocha's own order. */
function dealShards(files, count) {
  const shards = Array.from({ length: Math.min(count, Math.max(files.length, 1)) }, () => []);
  files.forEach((file, i) => shards[i % shards.length].push(file));
  return shards;
}

/** @returns {string|null} why the shards are not an exact partition of files, or null. */
function partitionError(files, shards) {
  const dealt = shards.flat();
  if (dealt.length !== files.length) return `dealt ${dealt.length} of ${files.length} files`;
  if (new Set(dealt).size !== dealt.length) return 'a file was dealt twice';
  const want = new Set(files);
  const stray = dealt.find((file) => !want.has(file));
  return stray ? `dealt a file mocha did not collect: ${stray}` : null;
}

const NOT_REPEATED = new Set(['_', 'spec', 'config', 'package', '$0']);

/**
 * @returns {string[]} every merged option that differs from mocha's default, as
 * flags, so a shard run with --no-config behaves as the step did with its rc.
 */
function shardArgs(opts, defaults) {
  const args = ['--no-config', '--no-package'];
  for (const [key, value] of Object.entries(opts)) {
    // yargs also sets a camelCase alias for every kebab-case key; one spelling is enough.
    if (NOT_REPEATED.has(key) || /[A-Z]/.test(key)) continue;
    if (JSON.stringify(value) === JSON.stringify(defaults[key])) continue;
    if (value === true) args.push(`--${key}`);
    else if (value === false) args.push(`--no-${key}`);
    else for (const item of [].concat(value)) args.push(`--${key}`, String(item));
  }
  return args;
}

/** @returns {{files: string[], args: string[]}} mocha's own file collection and the options each shard repeats. */
function collectMain(mainStep, cwd = process.cwd()) {
  // Resolved from the repo at run time because mocha lives in its node_modules.
  const mochaDir = path.join(cwd, 'node_modules', 'mocha');
  const { loadOptions } = require(path.join(mochaDir, 'lib', 'cli', 'options'));
  const collectFiles = require(path.join(mochaDir, 'lib', 'cli', 'collect-files'));
  const defaults = require(path.join(mochaDir, 'lib', 'mocharc.json'));
  const opts = loadOptions(words(mainStep).slice(1));
  const collected = collectFiles({
    ignore: [].concat(opts.ignore || []), extension: [].concat(opts.extension || ['js']), file: [],
    recursive: Boolean(opts.recursive), sort: Boolean(opts.sort), spec: opts._,
  });
  // Two of the step's globs overlap (test/unit/**/*.test.js and test/unit/*.test.js),
  // so mocha collects some files twice and loads them once; a shard does the same.
  const files = [...new Set((Array.isArray(collected) ? collected : collected.files)
    .map((file) => path.relative(cwd, file).split(path.sep).join('/')))];
  return { files, args: shardArgs(opts, defaults) };
}

/** Runs one shell step with the package's bin on PATH, as npm run would; resolves its exit status. */
function runStep(step, env) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', step], { env, stdio: 'inherit' });
    child.on('close', (code, signal) => resolve(signal ? 1 : code));
  });
}

/** Runs every shard with bounded concurrency and prints each shard's output as one block. */
async function runShards(shards, args, env, spawnShard = spawn, jobs = shards.length) {
  const started = Date.now();
  const results = new Array(shards.length);
  let next = 0;
  const runOne = (files, i) => new Promise((resolve) => {
    let out = '';
    const child = spawnShard(path.join('node_modules', '.bin', 'mocha'), [...args, ...files], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code, signal) => resolve({ i, files, out, ok: code === 0 && !signal, secs: Math.round((Date.now() - started) / 1000) }));
  });
  async function worker() {
    while (next < shards.length) {
      const i = next;
      next += 1;
      results[i] = await runOne(shards[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, shards.length)) }, worker));
  for (const r of results) {
    console.log(`ci:shard ===== shard ${r.i + 1}/${shards.length} (${r.files.length} files) =====`);
    process.stdout.write(r.out);
    console.log(`ci:shard ----- shard ${r.i + 1}/${shards.length} ${r.ok ? 'PASS' : 'FAIL'} (${r.secs}s)`);
  }
  return results.every((r) => r.ok);
}

/**
 * @returns {Promise<number>} the main step's exit status, sharded; run whole
 * instead, and say so, when mocha's collection cannot be read or dealt exactly.
 */
async function runMain(mainStep, cwd, env) {
  let plan;
  try {
    plan = collectMain(mainStep, cwd);
  } catch (error) {
    console.log(`ci:shard: cannot collect the files (${error.message}); running the step whole`);
    return runStep(mainStep, env);
  }
  const shards = dealShards(plan.files, shardCount(env, os.cpus().length, plan.files.length));
  const bad = partitionError(plan.files, shards);
  if (bad) {
    console.log(`ci:shard: the shards are not an exact partition (${bad}); running the step whole`);
    return runStep(mainStep, env);
  }
  const jobs = shardJobs(env, shards.length);
  console.log(`ci:shard: ${plan.files.length} files of \`${mainStep.slice(0, 60)}...\` in ${shards.length} shards (${jobs} at a time)`);
  return (await runShards(shards, plan.args, env, spawn, jobs)) ? 0 : 1;
}

/** @returns {Promise<number>} the chain's exit status, stopping at the first red step as `&&` does. */
async function runChain(chain, cwd = process.cwd()) {
  const env = { ...process.env, PATH: `${path.join(cwd, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH}` };
  for (const step of chain.before) {
    const code = await runStep(step, env);
    if (code !== 0) return code;
  }
  const main = await runMain(chain.main, cwd, env);
  if (main !== 0) return main;
  for (const step of chain.after) {
    const code = await runStep(step, env);
    if (code !== 0) return code;
  }
  return 0;
}

/** A spawn result's exit status; no status (npm missing, or a signal) is red, never 0. */
function exitOf(result) {
  return Number.isInteger(result && result.status) ? result.status : 1;
}

async function main() {
  const mode = process.argv[2];
  if (mode !== '--run' && mode !== '--list') {
    console.error('usage: node bin/ci_shard.js --run|--list');
    return 2;
  }
  const chain = splitChain(require(path.resolve('package.json')).scripts.ci);
  if (!chain) {
    console.log('ci:shard: the ci script has no single main mocha step; running `npm run ci` unsharded');
    return mode === '--run' ? exitOf(spawnSync('npm', ['run', 'ci'], { stdio: 'inherit' })) : 2;
  }
  if (mode === '--list') {
    const { files } = collectMain(chain.main);
    dealShards(files, shardCount()).forEach((shard, i) => shard.forEach((file) => console.log(`shard ${i + 1} ${file}`)));
    return 0;
  }
  return runChain(chain);
}

module.exports = { splitChain, words, shardCount, shardJobs, dealShards, partitionError, shardArgs, collectMain, runShards, exitOf };

if (require.main === module) main().then((code) => { process.exitCode = code; });
