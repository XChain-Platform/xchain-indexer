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
const guardSource = path.join(repoRoot, 'bin', 'check-hub-db-sync-explorer-twins.js');
const syncSource = path.join(repoRoot, 'bin', 'sync-hub-mirror-client.sh');

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
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
    git(repo, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);
  }

  const base = git(indexer, ['rev-parse', 'HEAD']);
  const relative = 'src/hub/hub_db_sync/live_events.js';
  fs.appendFileSync(path.join(indexer, relative), 'module.exports.twinOrderFixture = true;\n');
  commit(indexer, 'canonical twin change');
  git(explorer, ['switch', '--quiet', '-c', 'mirror-client-twin']);
  fs.copyFileSync(path.join(indexer, relative), path.join(explorer, relative));
  commit(explorer, 'vendored twin change');

  return { root, indexer, explorer, base, relative };
}

function runGuard(fixture, explorerPath) {
  return run(process.execPath, [path.join(fixture.indexer, 'bin', path.basename(guardSource))], {
    env: {
      ...process.env,
      PROM_CI_BASE_SHA: fixture.base,
      XCHAIN_INDEXER_PATH: fixture.indexer,
      XCHAIN_EXPLORER_PATH: explorerPath,
    },
  });
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

  it('rejects the stale explorer origin, accepts its named companion, then passes the explorer check', () => {
    const fixture = makeFixture();
    const originSnapshot = path.join(fixture.root, 'explorer-origin');
    try {
      const worktree = run('git', [
        '-C', fixture.explorer,
        'worktree', 'add', '--quiet', '--detach', originSnapshot, 'origin/develop',
      ]);
      assert.equal(worktree.status, 0, worktree.stdout + worktree.stderr);

      const stale = runGuard(fixture, originSnapshot);
      assert.equal(stale.status, 1, stale.stdout + stale.stderr);
      assert.match(stale.stdout, /DRIFT: .*live_events\.js differs/);

      const companion = runGuard(fixture, fixture.explorer);
      assert.equal(companion.status, 0, companion.stdout + companion.stderr);
      assert.match(companion.stdout, /1 changed canonical hub_db_sync explorer twin/);

      const explorerGate = run(
        'bash',
        [path.join(fixture.indexer, 'bin', 'sync-hub-mirror-client.sh'), '--check'],
      );
      assert.equal(explorerGate.status, 0, explorerGate.stdout + explorerGate.stderr);
      assert.match(explorerGate.stdout, /all vendored hub-mirror client copies are byte-identical/);
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
