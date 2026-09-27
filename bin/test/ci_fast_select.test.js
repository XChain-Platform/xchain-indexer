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
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveBase, selectFastTests } = require('../ci_fast_select.js');

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

function relativeRequireTargets(file) {
  const source = fs.readFileSync(file, 'utf8');
  const targets = [];
  const pattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let match;
  while ((match = pattern.exec(source))) {
    const base = path.resolve(path.dirname(file), match[1]);
    const resolved = path.extname(base) ? [base] : [`${base}.js`, path.join(base, 'index.js')];
    targets.push(...resolved.map((item) => path.relative(process.cwd(), item).split(path.sep).join('/')));
  }
  return targets;
}

function findRequirers(moduleFile) {
  const basename = path.posix.basename(moduleFile, '.js');
  return gitLines(['grep', '-l', '-F', basename, '--', 'src', 'test'], { allowNoMatches: true })
    .filter((file) => relativeRequireTargets(file).includes(moduleFile));
}

const dependencies = {
  listTests: () => gitLines(['ls-files', 'test/**']),
  findRequirers
};

function select(changedFiles) {
  return selectFastTests(changedFiles, dependencies);
}

describe('ci fast selector', function () {
  it('maps the CORS source to its unit test without widening', function () {
    const plan = select(['src/api/cors_origin.js']);
    assert.strictEqual(plan.consensus, false);
    assert(plan.tests.some((test) =>
      test.group === 'main' && test.file === 'test/unit/api/cors_origin.test.js'));
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
});
