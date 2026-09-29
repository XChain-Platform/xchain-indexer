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

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  findTrackedRequirers,
  findTrackedSupportUsers,
  resolveBase,
  selectFastTests
} = require('../ci_fast_select.js');

function git(args, options = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch (error) {
    if (options.allowNoMatches && error.status === 1) return '';
    throw error;
  }
}

function gitLines(args, options) {
  const output = git(args, options);
  return output ? output.split(/\r?\n/) : [];
}

const dependencies = {
  listTests: () => gitLines(['ls-files', 'test/**']),
  findRequirers: findTrackedRequirers,
  findSupportUsers: findTrackedSupportUsers
};

function select(changedFiles) {
  return selectFastTests(changedFiles, dependencies);
}

function scratchGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeScratchFile(cwd, file, source) {
  const target = path.join(cwd, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

function scratchCommit(cwd, message, files) {
  scratchGit(cwd, ['add', '--', ...files]);
  scratchGit(cwd, [
    '-c', 'user.name=Selector Test',
    '-c', 'user.email=selector-test',
    'commit', '-m', message
  ]);
}

describe('ci fast selector', function () {
  it('maps the CORS source to its unit test without widening', function () {
    const plan = select(['src/api/cors_origin.js']);
    assert.strictEqual(plan.consensus, false);
    assert(plan.tests.some((test) =>
      test.group === 'main' && test.file === 'test/unit/api/cors_origin.test.js'));
  });

  it('maps a source module to tests that name its git-grep tail', function () {
    const source = 'src/actions/actions_class/dispatch.js';
    const file = 'test/unit/action_dispatch/action_manifest_conformance.test.js';
    assert(findTrackedRequirers(source).includes(file));
    assert(select([source]).tests.some((test) => test.group === 'main' && test.file === file));
  });

  for (const changed of ['src/actions/address.js', 'src/protocol_changes/core.js']) {
    it(`widens a change to ${changed}`, function () {
      const plan = select([changed]);
      assert.strictEqual(plan.consensus, true);
      assert(plan.reasons.some((reason) => reason.includes(changed)));
    });
  }

  it('widens a source module required by a consensus path', function () {
    const changed = 'src/observability/index.js';
    const plan = select([changed]);
    assert.strictEqual(plan.consensus, true);
    assert(plan.reasons.some((reason) =>
      reason.startsWith('consensus importer: src/actions/')));
  });

  it('selects a changed runner-owned test exactly', function () {
    const file = 'test/unit/api/cors_origin.test.js';
    assert.deepStrictEqual(select([file]).tests, [{ group: 'main', file }]);
  });

  it('maps documentation changes only to the always list', function () {
    const plan = select(['README.md']);
    assert.strictEqual(plan.consensus, false);
    assert.deepStrictEqual(plan.tests, []);
  });

  it('widens package manifest changes', function () {
    const plan = select(['package.json']);
    assert.strictEqual(plan.consensus, true);
    assert(plan.reasons.some((reason) => reason.includes('package.json')));
  });

  it('defers a changed integration test', function () {
    const file = gitLines(['ls-files', 'test/integration/**/*.test.js', 'test/integration/*.test.js'])[0];
    assert(file);
    const plan = select([file]);
    assert.deepStrictEqual(plan.tests, []);
    assert(plan.reasons.includes(`deferred: ${file}`));
  });

  it('grades a changed shared fixture through its users instead of widening', function () {
    const plan = select(['test/fixtures/anchor_canonical_vectors.json']);
    assert.strictEqual(plan.consensus, false, plan.reasons.join('\n'));
    assert(plan.tests.some((test) => test.file === 'test/unit/actions/anchor_golden_vectors.test.js'));
  });

  it('selects every test that uses a changed nested helper', function () {
    const plan = select(['test/unit/actions/stake/deposit.test/helpers/custody_guard_fixture.js']);
    assert.strictEqual(plan.consensus, false);
    for (const file of [
      'test/unit/actions/stake/deposit.test/custody_guard.test.js',
      'test/unit/contracts/controller_enforcement.test/custody_guard_deposit_gas.test.js'
    ]) assert(plan.tests.some((test) => test.file === file), file);
  });

  it('follows a helper through the helper that requires it', function () {
    const users = {
      'test/unit/x/helpers/inner.js': ['test/unit/x/helpers/outer.js'],
      'test/unit/x/helpers/outer.js': ['test/unit/x/outer.test.js', 'test/integration/x.test.js']
    };
    const plan = selectFastTests(['test/unit/x/helpers/inner.js'], {
      listTests: () => ['test/unit/x/outer.test.js', 'test/unit/x/other.test.js'],
      findRequirers: () => [],
      findSupportUsers: (file) => users[file] || []
    });
    assert.strictEqual(plan.consensus, false);
    assert.deepStrictEqual(plan.tests, [{ group: 'main', file: 'test/unit/x/outer.test.js' }]);
    assert(plan.reasons.includes('deferred: test/integration/x.test.js'));
  });

  it('widens a test support file that nothing names, or that package.json loads', function () {
    const orphan = selectFastTests(['test/unit/x/helpers/orphan.js'], {
      listTests: () => ['test/unit/x/a.test.js'],
      findRequirers: () => [],
      findSupportUsers: () => []
    });
    assert.strictEqual(orphan.consensus, true);
    assert(orphan.reasons.includes('consensus: test/unit/x/helpers/orphan.js (no user found)'));
    const setup = select(['test/helpers/setup.js']);
    assert.strictEqual(setup.consensus, true);
  });

  it('returns null when neither promised nor merge base resolves', function () {
    const stub = (args) => ({ status: 1, stdout: '', stderr: args.join(' ') });
    assert.strictEqual(resolveBase({ env: { PROM_CI_BASE_SHA: 'unknown' }, git: stub }), null);
  });

  it('returns an accepted promised base without asking for a merge base', function () {
    const sha = '1234567890abcdef';
    const stub = (args) => {
      assert.strictEqual(args[0], 'cat-file');
      return { status: 0, stdout: '' };
    };
    assert.strictEqual(resolveBase({ env: { PROM_CI_BASE_SHA: sha }, git: stub }), sha);
  });

  it('falls back to the merge base after rejecting a promised base', function () {
    const mergeBase = 'abcdef1234567890';
    const stub = (args) => args[0] === 'cat-file'
      ? { status: 1, stdout: '' }
      : { status: 0, stdout: `${mergeBase}\n` };
    assert.strictEqual(resolveBase({
      env: { PROM_CI_BASE_SHA: 'unknown' },
      git: stub
    }), mergeBase);
  });

  it('keeps the full-tier integration command and fast-plan guard', function () {
    const script = fs.readFileSync('bin/ci-full.sh', 'utf8');
    assert(script.includes('ci_fast_select.js --plan'));
    assert(script.includes('CI_TIER'));
    assert(script.includes('run_tier "integration (test:integration:ci)"'));
  });

  it('replays develop history, compares narrowing, and checks required selections', function () {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-fast-select-replay-'));
    try {
      scratchGit(cwd, ['init', '--initial-branch=develop']);
      const initial = {
        'src/consensus/rule.js': "module.exports = 'rule';\n",
        'src/feature/plain.js': "module.exports = 'plain';\n",
        'test/unit/consensus/rule.test.js':
          "require('../../../src/consensus/rule');\n",
        'test/unit/feature/plain.test.js': "require('../../../src/feature/plain');\n",
        'test/unit/only.test.js': "module.exports = 'only';\n",
        'test/unit/other/unrelated.test.js': "module.exports = 'unrelated';\n"
      };
      for (const [file, source] of Object.entries(initial)) writeScratchFile(cwd, file, source);
      scratchCommit(cwd, 'initial files', Object.keys(initial));

      const consensusFile = 'src/consensus/rule.js';
      fs.appendFileSync(path.join(cwd, consensusFile), "module.exports += ' changed';\n");
      scratchCommit(cwd, 'consensus change', [consensusFile]);

      const plainFile = 'src/feature/plain.js';
      fs.appendFileSync(path.join(cwd, plainFile), "module.exports += ' changed';\n");
      scratchCommit(cwd, 'plain source change', [plainFile]);

      const testFile = 'test/unit/only.test.js';
      fs.appendFileSync(path.join(cwd, testFile), "module.exports += ' changed';\n");
      scratchCommit(cwd, 'test only change', [testFile]);
      scratchGit(cwd, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);

      const selector = path.resolve(__dirname, '../ci_fast_select.js');
      const mustSelect = [
        'src/consensus/rule.js:test/unit/consensus/rule.test.js',
        'src/feature/plain.js:test/unit/other/unrelated.test.js'
      ].join(',');
      const result = spawnSync(process.execPath, [
        selector,
        '--replay', '3',
        '--narrow', 'src/consensus/',
        '--must-select', mustSelect
      ], { cwd, encoding: 'utf8' });

      assert.strictEqual(result.status, 1, result.stderr);
      const lines = result.stdout.trim().split(/\r?\n/);
      assert(lines.includes('plan commits consensus-1 changed-tests test-only no-tests'));
      assert(lines.includes('current 3 1/3 1/3 1/3 0/3'));
      assert(lines.includes('narrowed 3 0/3 2/3 1/3 0/3'));
      assert(lines.includes(
        'must-select PASS src/consensus/rule.js:test/unit/consensus/rule.test.js'));
      assert(lines.includes(
        'must-select FAIL src/feature/plain.js:test/unit/other/unrelated.test.js'));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
