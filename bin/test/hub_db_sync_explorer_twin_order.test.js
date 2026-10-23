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

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..', '..');
const syncSource = path.join(repoRoot, 'bin', 'sync-hub-mirror-client.sh');

// Every child process gets this scrubbed environment so the fixture sees only
// its own temp repos. A CI venue exports CI_SIBLING_PINS naming the real
// explorer SHA it shipped; inherited, it pinned the fixture's explorer to a
// commit that exists only on the venue and the hook failed before comparing.
// Global and system git config are dropped for the same reason (a venue's
// core.hooksPath or url rewrites would bypass or redirect the fixture hooks).
const HERMETIC_ENV = (() => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CI_|PROM_CI_|XCHAIN_|GIT_)/.test(key)) continue;
    env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
})();

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', env: HERMETIC_ENV, ...options });
}

function withEnv(extra) {
  return { env: { ...HERMETIC_ENV, ...extra } };
}

function git(root, args) {
  const result = run('git', ['-C', root, ...args]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

function commit(root, message) {
  git(root, ['add', '.']);
  git(root, [
    '-c', 'user.name=Twin Order Test',
    '-c', 'user.email=twin-order@example.invalid',
    'commit', '--quiet', '-m', message,
  ]);
}

function installHook(root, source) {
  const hook = path.join(root, '.git', 'hooks', 'pre-push');
  fs.writeFileSync(hook, source, { mode: 0o755 });
}

function shellWords(source, name) {
  const match = source.match(new RegExp(`^${name}="([^"]*)"`, 'm'));
  assert(match, `${name} is declared`);
  return match[1].split(/\s+/).filter(Boolean);
}

function copyFile(sourceRoot, targetRoot, relative) {
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, relative), target);
}

function makeFixture() {
  const scratchRoot = path.join(repoRoot, 'tmp');
  fs.mkdirSync(scratchRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'hub-twin-order-'));
  const indexer = path.join(root, 'xchain-indexer');
  const explorer = path.join(root, 'xchain-explorer');
  const script = fs.readFileSync(syncSource, 'utf8');

  for (const file of shellWords(script, 'HUB_FILES')) {
    copyFile(repoRoot, indexer, path.join('src', 'hub', file));
  }
  for (const directory of shellWords(script, 'HUB_DIRS')) {
    fs.cpSync(
      path.join(repoRoot, 'src', 'hub', directory),
      path.join(indexer, 'src', 'hub', directory),
      { recursive: true },
    );
  }
  for (const file of shellWords(script, 'DEP_FILES')) {
    copyFile(repoRoot, indexer, path.join('src', file));
  }
  for (const file of shellWords(script, 'SQL_FILES')) {
    copyFile(repoRoot, indexer, path.join('src', 'sql', file));
  }
  copyFile(repoRoot, indexer, path.join('bin', 'sync-hub-mirror-client.sh'));
  copyFile(repoRoot, indexer, path.join('bin', 'check-hub-db-sync-explorer-twins.js'));
  fs.mkdirSync(path.join(explorer, 'src', 'consensus'), { recursive: true });
  fs.writeFileSync(path.join(explorer, 'src', 'consensus', 'gate_registry.js'), '\n');

  const initialSync = run('bash', [path.join(indexer, 'bin', 'sync-hub-mirror-client.sh')]);
  assert.equal(initialSync.status, 0, initialSync.stdout + initialSync.stderr);

  for (const repo of [indexer, explorer]) {
    git(repo, ['init', '--quiet', '-b', 'develop']);
    commit(repo, 'fixture base');
    const remote = path.join(root, `${path.basename(repo)}.git`);
    git(root, ['init', '--quiet', '--bare', remote]);
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '--quiet', '--set-upstream', 'origin', 'develop']);
  }

  const base = git(indexer, ['rev-parse', 'HEAD']);
  const relative = 'src/hub/hub_db_sync/live_events.js';
  fs.appendFileSync(path.join(indexer, relative), 'module.exports.twinOrderFixture = true;\n');
  commit(indexer, 'canonical twin change');
  git(explorer, ['switch', '--quiet', '-c', 'mirror-client-twin']);
  fs.copyFileSync(path.join(indexer, relative), path.join(explorer, relative));
  commit(explorer, 'vendored twin change');
  git(explorer, ['switch', '--quiet', 'develop']);

  installHook(indexer, `#!/usr/bin/env bash
set -eu
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PROM_CI_BASE_SHA="${base}" \
XCHAIN_INDEXER_PATH="$ROOT/xchain-indexer" \
XCHAIN_EXPLORER_PATH="$ROOT/xchain-explorer" \
"${process.execPath}" "$ROOT/xchain-indexer/bin/check-hub-db-sync-explorer-twins.js"
`);
  installHook(explorer, `#!/usr/bin/env bash
set -eu
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
bash "$ROOT/xchain-indexer/bin/sync-hub-mirror-client.sh" --check
`);

  return { root, indexer, explorer, base };
}

describe('hub DB sync explorer twin landing order', function () {
  this.timeout(15000);

  it('documents the indexer-first push using a named explorer companion branch', () => {
    const result = run('bash', [syncSource, '--landing-order', 'mirror-client-twin']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Push and land xchain-indexer first/);
    assert.match(
      result.stdout,
      /CI_COMPANIONS="xchain-explorer=mirror-client-twin" git push/,
    );
    assert.match(result.stdout, /indexer commit is on origin\/develop/);
    assert.match(result.stdout, /push and land xchain-explorer normally/);
  });

  it('lands indexer with the named companion before a normal explorer push', () => {
    const fixture = makeFixture();
    try {
      const stale = run(
        'git',
        ['-C', fixture.indexer, 'push', 'origin', 'HEAD:develop'],
        withEnv({ CI_COMPANIONS: '' }),
      );
      assert.equal(stale.status, 1, stale.stdout + stale.stderr);
      assert.match(stale.stdout + stale.stderr, /DRIFT: .*live_events\.js differs/);
      assert.equal(git(fixture.indexer, ['rev-parse', 'origin/develop']), fixture.base);

      const companion = run(
        'git',
        ['-C', fixture.indexer, 'push', 'origin', 'HEAD:develop'],
        withEnv({ CI_COMPANIONS: 'xchain-explorer=mirror-client-twin' }),
      );
      assert.equal(companion.status, 0, companion.stdout + companion.stderr);
      assert.match(
        companion.stdout + companion.stderr,
        /1 changed canonical hub_db_sync explorer twin.*companion ref mirror-client-twin/,
      );
      assert.equal(
        git(fixture.indexer, ['rev-parse', 'origin/develop']),
        git(fixture.indexer, ['rev-parse', 'HEAD']),
      );

      git(fixture.explorer, ['switch', '--quiet', 'mirror-client-twin']);
      const explorerPush = run(
        'git',
        ['-C', fixture.explorer, 'push', 'origin', 'mirror-client-twin:develop'],
      );
      assert.equal(explorerPush.status, 0, explorerPush.stdout + explorerPush.stderr);
      assert.match(
        explorerPush.stdout + explorerPush.stderr,
        /all vendored hub-mirror client copies are byte-identical/,
      );
      assert.equal(
        git(fixture.explorer, ['rev-parse', 'origin/develop']),
        git(fixture.explorer, ['rev-parse', 'mirror-client-twin']),
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('accepts the venue form, where the dispatcher pins the companion SHA', () => {
    const fixture = makeFixture();
    try {
      const companionSha = git(fixture.explorer, ['rev-parse', 'mirror-client-twin']);
      const foreign = run(
        'git',
        ['-C', fixture.indexer, 'push', 'origin', 'HEAD:develop'],
        withEnv({ CI_SIBLING_PINS: `xchain-explorer=${'0'.repeat(40)}` }),
      );
      assert.equal(foreign.status, 1, foreign.stdout + foreign.stderr);
      assert.match(foreign.stdout + foreign.stderr, /companion ref 0{40} does not resolve/);
      assert.equal(git(fixture.indexer, ['rev-parse', 'origin/develop']), fixture.base);

      const pinned = run(
        'git',
        ['-C', fixture.indexer, 'push', 'origin', 'HEAD:develop'],
        withEnv({ CI_SIBLING_PINS: `xchain-sdk=${fixture.base} xchain-explorer=${companionSha}` }),
      );
      assert.equal(pinned.status, 0, pinned.stdout + pinned.stderr);
      assert.match(pinned.stdout + pinned.stderr, new RegExp(`companion ref ${companionSha}`));
      assert.equal(
        git(fixture.indexer, ['rev-parse', 'origin/develop']),
        git(fixture.indexer, ['rev-parse', 'HEAD']),
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses a companion value that is unsafe to paste into the push command', () => {
    const result = run('bash', [syncSource, '--landing-order', 'branch$(false)']);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /explorer branch must use only/);
  });
});
