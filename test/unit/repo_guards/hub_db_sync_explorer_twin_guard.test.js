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
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..', '..', '..');
const guardScript = path.join(repoRoot, 'bin', 'check-hub-db-sync-explorer-twins.js');

function write(root, relative, contents = `${relative}\n`) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function twinFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mirror-twins-'));
  const indexer = path.join(root, 'xchain-indexer');
  const explorer = path.join(root, 'xchain-explorer');
  for (const file of [
    'src/hub/hub_db_sync/live_events.js',
    'src/hub/hub_db_sync/chain_identity.js',
  ]) {
    write(indexer, file);
    write(explorer, file);
  }
  runGit(indexer, ['init', '--quiet']);
  runGit(indexer, ['config', 'user.email', 'guard@example.invalid']);
  runGit(indexer, ['config', 'user.name', 'Guard Test']);
  runGit(indexer, ['add', 'src']);
  runGit(indexer, ['commit', '--quiet', '-m', 'fixture base']);
  const base = runGit(indexer, ['rev-parse', 'HEAD']).stdout.trim();
  return { root, indexer, explorer, base };
}

function runGit(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}

function runGuard(fixture) {
  return spawnSync(process.execPath, [guardScript], {
    cwd: fixture.indexer,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROM_CI_BASE_SHA: fixture.base,
      XCHAIN_INDEXER_PATH: fixture.indexer,
      XCHAIN_EXPLORER_PATH: fixture.explorer,
    },
  });
}

describe('hub DB sync explorer twin guard', () => {
  it('is an indexer CI drift tier with the explorer checkout required', () => {
    const ci = fs.readFileSync(path.join(repoRoot, 'bin', 'ci-full.sh'), 'utf8');
    assert.match(ci, /need_sib[^\n]*xchain-explorer/);
    assert.match(
      ci,
      /run_tier "drift: changed hub_db_sync explorer twins" node bin\/check-hub-db-sync-explorer-twins\.js/,
    );
  });

  it('checks only pushed canonical changes and names both drifted twin files', () => {
    const fixture = twinFixture();
    try {
      fs.appendFileSync(
        path.join(fixture.explorer, 'src', 'hub', 'hub_db_sync', 'chain_identity.js'),
        'pre-existing drift\n',
      );
      const unchanged = runGuard(fixture);
      assert.equal(unchanged.status, 0, unchanged.stdout + unchanged.stderr);
      assert.match(unchanged.stdout, /no canonical hub_db_sync files changed/);

      fs.appendFileSync(
        path.join(fixture.indexer, 'src', 'hub', 'hub_db_sync', 'live_events.js'),
        'canonical change\n',
      );
      runGit(fixture.indexer, ['add', 'src/hub/hub_db_sync/live_events.js']);
      runGit(fixture.indexer, ['commit', '--quiet', '-m', 'change canonical part']);

      const drift = runGuard(fixture);
      assert.equal(drift.status, 1, drift.stdout + drift.stderr);
      assert.match(
        drift.stdout,
        /DRIFT: xchain-explorer\/src\/hub\/hub_db_sync\/live_events\.js differs from canonical xchain-indexer\/src\/hub\/hub_db_sync\/live_events\.js/,
      );
      assert.doesNotMatch(drift.stdout, /chain_identity/);

      fs.copyFileSync(
        path.join(fixture.indexer, 'src', 'hub', 'hub_db_sync', 'live_events.js'),
        path.join(fixture.explorer, 'src', 'hub', 'hub_db_sync', 'live_events.js'),
      );
      const synced = runGuard(fixture);
      assert.equal(synced.status, 0, synced.stdout + synced.stderr);
      assert.match(synced.stdout, /1 changed canonical hub_db_sync explorer twin/);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a pushed canonical file when its explorer twin is missing', () => {
    const fixture = twinFixture();
    try {
      const relative = 'src/hub/hub_db_sync/live_events.js';
      fs.appendFileSync(path.join(fixture.indexer, relative), 'canonical change\n');
      fs.rmSync(path.join(fixture.explorer, relative));
      runGit(fixture.indexer, ['add', relative]);
      runGit(fixture.indexer, ['commit', '--quiet', '-m', 'change canonical part']);

      const drift = runGuard(fixture);
      assert.equal(drift.status, 1, drift.stdout + drift.stderr);
      assert.match(
        drift.stdout,
        /DRIFT: xchain-explorer\/src\/hub\/hub_db_sync\/live_events\.js differs from canonical xchain-indexer\/src\/hub\/hub_db_sync\/live_events\.js/,
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
