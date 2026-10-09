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
  'bin/lib/'
];
// A changed file under test/ that no runner owns (a helper, a fixture) cannot
// change consensus code, so it is graded through the tests that use it rather
// than by running the whole unit tier. It still widens when something outside
// the test graph names it (package.json, the mocha config, src/, or bin/ outside
// its own tests), or when no user of it can be found, because then nothing says
// what it can break.
const SUPPORT_OUTSIDE = /^(?:src\/|bin\/(?!test\/)|package\.json$|\.mocharc)/;
const ALWAYS = [];
const CI_HELPER_TEST = 'bin/test/ci_fast_select.test.js';
const CI_HELPERS = new Set([
  'bin/ci-full.sh',
  'bin/ci_fast_select.js',
  'bin/vendor-vm.sh'
]);
const GROUPS = [
  {
    group: 'main',
    args: ['--timeout', '30000', '--recursive', '--exit'],
    patterns: [
      /^bin\/test\/(?:.*\/)?[^/]+\.test\.js$/,
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

function addConsensusReasons(changedFiles, findRequirers, reasons, consensusPrefixes) {
  let consensus = false;
  for (const file of changedFiles) {
    const direct = consensusPrefixes.some((prefix) => matchesPrefix(file, prefix));
    if (direct || file === 'package.json') {
      reasons.add(`consensus: ${file}`);
      consensus = true;
    }
  }
  for (const file of changedFiles.filter((item) => item.startsWith('src/'))) {
    for (const requirer of findRequirers(file)) {
      if (consensusPrefixes.some((prefix) => matchesPrefix(requirer, prefix))) {
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

function isSupportFile(file) {
  return file.startsWith('test/') && !isTestFile(file) && !file.endsWith('.md');
}

// Walks outward from each changed support file through the files that name it:
// a runner-owned test is selected, a test no runner owns is deferred, and a
// support file that names it is walked in turn, so a helper reached only
// through another helper still selects its tests. Returns true to widen.
function addSupportTests(supportFiles, { existing, findSupportUsers }, reasons, selected) {
  let widen = false;
  const seen = new Set(supportFiles);
  const queue = [...supportFiles];
  while (queue.length) {
    const file = queue.shift();
    const users = findSupportUsers ? findSupportUsers(file).filter((user) => user !== file) : [];
    const outside = users.find((user) => SUPPORT_OUTSIDE.test(user));
    if (!users.length || outside) {
      reasons.add(`consensus: ${file} (${outside ? `named by ${outside}` : 'no user found'})`);
      widen = true;
      continue;
    }
    for (const user of users) {
      if (matchingGroup(user)) {
        if (existing.has(user)) selected.add(user);
      } else if (isTestFile(user)) {
        reasons.add(`deferred: ${user}`);
      } else if (isSupportFile(user) && !seen.has(user)) {
        seen.add(user);
        queue.push(user);
      }
    }
  }
  return widen;
}

function selectFastTests(
  changedFiles,
  { listTests, findRequirers, findSupportUsers },
  { consensusPrefixes = CONSENSUS } = {}
) {
  const changed = [...new Set(changedFiles.map((file) => file.replace(/^\.\//, '')))];
  const allTests = [...new Set(listTests())].filter((file) => matchingGroup(file));
  const existing = new Set(allTests);
  const reasons = new Set();
  const selected = new Set(ALWAYS.filter((file) => existing.has(file)));
  const requirers = new Map();
  for (const file of changed.filter((item) => item.startsWith('src/'))) {
    requirers.set(file, findRequirers(file));
  }
  const support = changed.filter(isSupportFile);
  const supportWidens = addSupportTests(support, { existing, findSupportUsers }, reasons, selected);
  const consensus = addConsensusReasons(
    changed,
    (file) => requirers.get(file) || [],
    reasons,
    consensusPrefixes
  ) || supportWidens;
  for (const file of changed) {
    if (CI_HELPERS.has(file) && existing.has(CI_HELPER_TEST)) selected.add(CI_HELPER_TEST);
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
  return gitLines(['ls-files', 'test/**', 'bin/test/**'])
    .filter((file) => matchingGroup(file) && fs.existsSync(file));
}

function requireTargetsFromSource(file, source) {
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

function requireTargets(file) {
  return requireTargetsFromSource(file, fs.readFileSync(file, 'utf8'));
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

// Every tracked file that names a test support file by its stem (the parent
// directory for an index.js): a require, a path.join of the fixture name, or a
// package script. A plain mention is enough on purpose; selecting a test that
// only mentions the name costs time, while missing a real user costs a red
// develop that the full sweep finds hours later.
function findTrackedSupportUsers(supportFile) {
  const ext = path.posix.extname(supportFile);
  let stem = path.posix.basename(supportFile, ext);
  if (stem === 'index') stem = path.posix.basename(path.posix.dirname(supportFile));
  return gitLines(['grep', '-l', '-F', '-e', stem, '--', 'test', 'src', 'bin', 'package.json', '.mocharc.yml'], true)
    .filter((file) => !(file.startsWith('test/') && file.endsWith('.md')));
}

function selectionDependencies({ indexed = false } = {}) {
  const tests = listTrackedTests();
  if (indexed) {
    const files = gitLines(['ls-files', 'src', 'test']).filter((file) => fs.existsSync(file));
    const importers = new Map();
    const testSources = new Map();
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      if (matchingGroup(file)) testSources.set(file, source);
      for (const target of requireTargetsFromSource(file, source)) {
        if (!importers.has(target)) importers.set(target, []);
        importers.get(target).push(file);
      }
    }
    const requirerCache = new Map();
    const supportCache = new Map();
    return {
      listTests: () => tests,
      findRequirers: (moduleFile) => {
        if (!requirerCache.has(moduleFile)) {
          const moduleTail = moduleFile.replace(/\.js$/, '');
          const namedTests = [...testSources]
            .filter(([, source]) => source.includes(moduleTail))
            .map(([file]) => file);
          requirerCache.set(moduleFile, [
            ...new Set([...(importers.get(moduleFile) || []), ...namedTests])
          ]);
        }
        return requirerCache.get(moduleFile);
      },
      findSupportUsers: (file) => {
        if (!supportCache.has(file)) supportCache.set(file, findTrackedSupportUsers(file));
        return supportCache.get(file);
      }
    };
  }
  return {
    listTests: () => tests,
    findRequirers: findTrackedRequirers,
    findSupportUsers: findTrackedSupportUsers
  };
}

function withoutConsensusPrefixes(prefixes) {
  const removed = new Set(prefixes.flatMap((prefix) => {
    const trimmed = prefix.trim();
    if (!trimmed) return [];
    return [trimmed, trimmed.endsWith('/') ? trimmed.slice(0, -1) : `${trimmed}/`];
  }));
  return CONSENSUS.filter((prefix) => !removed.has(prefix));
}

function changedFilesForCommit(commit) {
  const revision = gitLines(['rev-list', '--parents', '-n', '1', commit])[0];
  const [, parent] = revision.split(' ');
  if (parent) return gitLines(['diff', '--name-only', `${parent}..${commit}`]);
  return gitLines(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit]);
}

function emptyReplayCounts() {
  return { wholeUnit: 0, changedTests: 0, testOnly: 0, noTests: 0 };
}

function countReplayPlan(counts, changed, plan) {
  if (plan.consensus) {
    counts.wholeUnit++;
  } else if (plan.tests.length && changed.every((file) => file.startsWith('test/'))) {
    counts.testOnly++;
  } else if (plan.tests.length) {
    counts.changedTests++;
  } else {
    counts.noTests++;
  }
}

function replayPlans(limit, narrowPrefixes) {
  const commits = gitLines([
    'log', '--first-parent', '-n', String(limit), '--format=%H', 'origin/develop'
  ]);
  const current = emptyReplayCounts();
  const narrowed = emptyReplayCounts();
  const consensusPrefixes = withoutConsensusPrefixes(narrowPrefixes);
  const dependencies = selectionDependencies({ indexed: true });
  for (const commit of commits) {
    const changed = changedFilesForCommit(commit);
    countReplayPlan(current, changed, selectFastTests(changed, dependencies));
    countReplayPlan(narrowed, changed, selectFastTests(changed, dependencies, {
      consensusPrefixes
    }));
  }
  return { commits, current, narrowed, consensusPrefixes, dependencies };
}

function fraction(value, total) {
  return `${value}/${total}`;
}

function printReplayRow(name, total, counts) {
  console.log([
    name,
    total,
    fraction(counts.wholeUnit, total),
    fraction(counts.changedTests, total),
    fraction(counts.testOnly, total),
    fraction(counts.noTests, total)
  ].join(' '));
}

function parseList(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseMustSelect(value) {
  return parseList(value).map((pair) => {
    const separator = pair.indexOf(':');
    if (separator <= 0 || separator === pair.length - 1) {
      throw new Error(`invalid --must-select pair: ${pair}`);
    }
    return { source: pair.slice(0, separator), test: pair.slice(separator + 1) };
  });
}

function replayOptions(args) {
  const limit = Number(args[0]);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('--replay requires a positive integer');
  }
  const options = { limit, narrowPrefixes: [], mustSelect: [] };
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || (flag !== '--narrow' && flag !== '--must-select')) {
      throw new Error(`invalid replay option: ${flag || ''}`.trim());
    }
    if (flag === '--narrow') options.narrowPrefixes.push(...parseList(value));
    else options.mustSelect.push(...parseMustSelect(value));
  }
  return options;
}

function runReplay(args) {
  let options;
  try {
    options = replayOptions(args);
    const result = replayPlans(options.limit, options.narrowPrefixes);
    console.log('plan commits consensus-1 changed-tests test-only no-tests');
    printReplayRow('current', result.commits.length, result.current);
    if (options.narrowPrefixes.length) {
      printReplayRow('narrowed', result.commits.length, result.narrowed);
    }
    let failed = false;
    for (const pair of options.mustSelect) {
      const plan = selectFastTests([pair.source], result.dependencies, {
        consensusPrefixes: result.consensusPrefixes
      });
      const selected = plan.tests.some((test) => test.file === pair.test);
      console.log(`must-select ${selected ? 'PASS' : 'FAIL'} ${pair.source}:${pair.test}`);
      if (!selected) failed = true;
    }
    return failed ? 1 : 0;
  } catch (error) {
    console.error(`replay-error ${error.message}`);
    return 2;
  }
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
      findRequirers: findTrackedRequirers,
      findSupportUsers: findTrackedSupportUsers
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
  if (mode === '--replay') return runReplay(process.argv.slice(3));
  if (mode !== '--plan' && mode !== '--run') {
    console.error('usage: node bin/ci_fast_select.js --plan|--run|--replay N ' +
      '[--narrow prefix,...] [--must-select file:testfile,...]');
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

module.exports = {
  findTrackedRequirers,
  findTrackedSupportUsers,
  replayPlans,
  resolveBase,
  selectFastTests
};

if (require.main === module) process.exitCode = main();
