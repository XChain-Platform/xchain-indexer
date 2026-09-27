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

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CONSENSUS = [
  'src/consensus/',
  'src/protocol_changes/',
  'src/protocol_changes.js',
  'src/consensus_rules_digest.js',
  'src/actions/',
  'src/state_commitment/',
  'src/rollback/',
  'src/protocol/',
  'src/coins/',
  'src/sql/',
  'src/chain/',
  'src/attestation/',
  'src/db/',
  'src/hub/',
  'src/XChainIndexer.js',
  'src/XChainIndexer/',
  'src/utility.js',
  'src/utility/',
  'bin/pins/',
  'bin/lib/',
  'bin/vendor-vm.sh'
];
const WIDEN = ['test/helpers/', 'test/fixtures/'];
const ALWAYS = [];
const GROUPS = [
  {
    group: 'main',
    args: ['--timeout', '30000', '--recursive', '--exit'],
    patterns: [
      /^test\/unit\/(?:.*\/)?[^/]+\.test\.js$/,
      /^test\/regression\/(?:.*\/)?[^/]+\.test\.js$/,
      /^test\/security\/(?:.*\/)?[^/]+\.test\.js$/
    ]
  },
  {
    group: 'chaos',
    args: ['--timeout', '10000'],
    patterns: [/^test\/chaos\/suites\/[^/]+\.test\.js$/]
  },
  {
    group: 'guard',
    args: ['--timeout', '10000'],
    patterns: [/^test\/mutation\/suites\/[^/]+\.test\.js$/]
  },
  {
    group: 'fuzz',
    env: { FUZZ_RUNS: '1000' },
    args: ['--timeout', '60000', '--exit', '--grep', '@tier1'],
    patterns: [/^test\/fuzz\/suites\/[^/]+\.fuzz\.js$/]
  },
  {
    group: 'smoke',
    args: ['--timeout', '5000'],
    patterns: [/^test\/smoke\/unit\/(?:.*\/)?[^/]+\.test\.js$/]
  },
  {
    group: 'boundary',
    args: ['--timeout', '5000'],
    patterns: [/^test\/boundary\/(?:.*\/)?[^/]+\.test\.js$/]
  }
];

function normalizeResult(result) {
  if (typeof result === 'string') return { ok: true, stdout: result, stderr: '' };
  if (!result) return { ok: false, stdout: '', stderr: '' };
  return {
    ok: result.ok === true || result.status === 0 || result.code === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || '')
  };
}

function callGit(git, args) {
  try {
    return normalizeResult(git(args));
  } catch (error) {
    return { ok: false, stdout: '', stderr: error.message };
  }
}

function resolveBase({ env, git }) {
  const promised = env.PROM_CI_BASE_SHA;
  if (promised) {
    const check = callGit(git, ['cat-file', '-e', `${promised}^{commit}`]);
    if (check.ok) return promised;
  }
  const mergeBase = callGit(git, ['merge-base', 'HEAD', 'origin/develop']);
  if (!mergeBase.ok) return null;
  return mergeBase.stdout.trim() || null;
}

function matchingGroup(file) {
  return GROUPS.find(({ patterns }) => patterns.some((pattern) => pattern.test(file)));
}

function matchesPrefix(file, prefix) {
  return file.startsWith(prefix);
}

function addConsensusReasons(changedFiles, findRequirers, reasons) {
  let consensus = false;
  for (const file of changedFiles) {
    const direct = [...CONSENSUS, ...WIDEN].some((prefix) => matchesPrefix(file, prefix));
    if (direct || file === 'package.json') {
      reasons.add(`consensus: ${file}`);
      consensus = true;
    }
  }
  for (const file of changedFiles.filter((item) => item.startsWith('src/'))) {
    for (const requirer of findRequirers(file)) {
      if (CONSENSUS.some((prefix) => matchesPrefix(requirer, prefix))) {
        reasons.add(`consensus importer: ${requirer}`);
        consensus = true;
      }
    }
  }
  return consensus;
}

function sourceDirectoryMatch(test, sourceFile) {
  const sourceDirectory = path.posix.dirname(sourceFile.slice('src/'.length));
  const relativeDirectory = sourceDirectory === '.' ? '' : sourceDirectory;
  const parts = test.split('/');
  if (parts[0] !== 'test' || parts.length < 3) return false;
  const testDirectory = parts.slice(2, -1).join('/');
  return testDirectory === relativeDirectory;
}

function sourceNameMatch(test, sourceFile) {
  const basename = path.posix.basename(sourceFile, '.js');
  if (basename === 'index') return false;
  return path.posix.basename(test) === `${basename}.test.js`;
}

function sourceDirectorySuiteMatch(test, sourceFile) {
  const basename = path.posix.basename(sourceFile, '.js');
  return test.split('/').includes(`${basename}.test`);
}

function addSourceTests(sourceFile, tests, requirers, selected) {
  for (const test of tests) {
    if (sourceNameMatch(test, sourceFile) ||
        sourceDirectorySuiteMatch(test, sourceFile) ||
        sourceDirectoryMatch(test, sourceFile)) {
      selected.add(test);
    }
  }
  for (const requirer of requirers) {
    if (matchingGroup(requirer)) selected.add(requirer);
  }
}

function isTestFile(file) {
  return /(?:\.test\.js|\.fuzz\.js)$/.test(file);
}

function selectFastTests(changedFiles, { listTests, findRequirers }) {
  const changed = [...new Set(changedFiles.map((file) => file.replace(/^\.\//, '')))];
  const allTests = [...new Set(listTests())].filter((file) => matchingGroup(file));
  const existing = new Set(allTests);
  const reasons = new Set();
  const selected = new Set(ALWAYS.filter((file) => existing.has(file)));
  const requirers = new Map();
  for (const file of changed.filter((item) => item.startsWith('src/'))) {
    requirers.set(file, findRequirers(file));
  }
  const consensus = addConsensusReasons(
    changed,
    (file) => requirers.get(file) || [],
    reasons
  );
  for (const file of changed) {
    if (existing.has(file)) selected.add(file);
    else if (file.startsWith('test/') && isTestFile(file) && !matchingGroup(file)) {
      reasons.add(`deferred: ${file}`);
    }
    if (file.startsWith('src/')) addSourceTests(file, allTests, requirers.get(file), selected);
  }
  const tests = [...selected].sort().map((file) => ({
    group: matchingGroup(file).group,
    file
  }));
  return { consensus, reasons: [...reasons].sort(), tests };
}

function systemGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function gitLines(args, allowNoMatches = false) {
  const result = systemGit(args);
  if (!result.status) return result.stdout.split(/\r?\n/).filter(Boolean);
  if (allowNoMatches && result.status === 1) return [];
  throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
}

function listTrackedTests() {
  return gitLines(['ls-files', 'test/**'])
    .filter((file) => matchingGroup(file) && fs.existsSync(file));
}

function requireTargets(file) {
  const source = fs.readFileSync(file, 'utf8');
  const targets = [];
  const pattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let match;
  while ((match = pattern.exec(source))) {
    const base = path.resolve(path.dirname(file), match[1]);
    if (path.extname(base)) targets.push(base);
    else targets.push(`${base}.js`, path.join(base, 'index.js'));
  }
  return targets.map((target) => path.relative(process.cwd(), target).split(path.sep).join('/'));
}

function findTrackedRequirers(moduleFile) {
  const basename = path.posix.basename(moduleFile, '.js');
  const candidates = gitLines(['grep', '-l', '-F', basename, '--', 'src', 'test'], true);
  const importers = candidates.filter((file) => requireTargets(file).includes(moduleFile));
  const moduleTail = moduleFile.replace(/\.js$/, '');
  const namedTests = gitLines(['grep', '-l', '-F', moduleTail, '--', 'test'], true)
    .filter((file) => matchingGroup(file));
  return [...new Set([...importers, ...namedTests])];
}

function computePlan() {
  const base = resolveBase({ env: process.env, git: systemGit });
  if (!base) {
    const why = process.env.PROM_CI_BASE_SHA
      ? 'PROM_CI_BASE_SHA is not a commit and origin/develop has no merge-base'
      : 'origin/develop has no merge-base';
    return { error: `no-base ${why}`, status: 3 };
  }
  try {
    const changed = gitLines(['diff', '--name-only', `${base}...HEAD`]);
    return { plan: selectFastTests(changed, {
      listTests: listTrackedTests,
      findRequirers: findTrackedRequirers
    }) };
  } catch (error) {
    return { error: `git-error ${error.message}`, status: 2 };
  }
}

function printPlan(plan) {
  console.log(`consensus ${plan.consensus ? 1 : 0}`);
  for (const reason of plan.reasons) console.log(`reason ${reason}`);
  for (const test of plan.tests) console.log(`test ${test.group} ${test.file}`);
}

function runPlan(plan) {
  let failed = false;
  for (const group of GROUPS) {
    const files = plan.tests.filter((test) => test.group === group.group).map((test) => test.file);
    if (!files.length) continue;
    const command = ['./node_modules/.bin/mocha', '--no-config', ...group.args, ...files];
    const result = spawnSync(command[0], command.slice(1), {
      env: { ...process.env, ...(group.env || {}) },
      stdio: 'inherit'
    });
    if (result.status !== 0) failed = true;
  }
  if (!plan.tests.length) console.log('ci:fast: no test maps to this push');
  return failed ? 1 : 0;
}

function main() {
  const mode = process.argv[2];
  if (mode !== '--plan' && mode !== '--run') {
    console.error('usage: node bin/ci_fast_select.js --plan|--run');
    return 2;
  }
  const result = computePlan();
  if (result.error) {
    console.log(result.error);
    return result.status;
  }
  if (mode === '--plan') {
    printPlan(result.plan);
    return 0;
  }
  return runPlan(result.plan);
}

module.exports = { findTrackedRequirers, resolveBase, selectFastTests };

if (require.main === module) process.exitCode = main();
