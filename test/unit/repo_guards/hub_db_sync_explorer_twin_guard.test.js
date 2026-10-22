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
const syncScript = fs.readFileSync(
  path.join(repoRoot, 'bin', 'sync-hub-mirror-client.sh'),
  'utf8',
);

function declaredWords(name) {
  const match = syncScript.match(new RegExp('^' + name + '="([^"]*)"$', 'm'));
  assert.ok(match, `${name} declaration is missing from the sync script`);
  return match[1].split(/\s+/).filter(Boolean);
}

function write(root, relative, contents = `${relative}\n`) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function twinFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mirror-twins-'));
  const indexer = path.join(root, 'xchain-indexer');
  const explorer = path.join(root, 'xchain-explorer');
  write(indexer, 'bin/sync-hub-mirror-client.sh', syncScript);

  for (const file of declaredWords('HUB_FILES')) {
    write(indexer, `src/hub/${file}`);
    write(explorer, `src/hub/${file}`);
  }
  for (const directory of declaredWords('HUB_DIRS')) {
    write(indexer, `src/hub/${directory}/live_events.js`);
    write(explorer, `src/hub/${directory}/live_events.js`);
  }
  for (const file of declaredWords('DEP_FILES')) {
    write(indexer, `src/${file}`);
    write(explorer, `src/${file}`);
  }
  for (const file of declaredWords('SQL_FILES')) {
    const contents = `${file}\n`;
    write(indexer, `src/sql/${file}`, contents);
    write(explorer, `src/sql/hub-mirror/${file}`, contents);
  }
  write(explorer, `src/${declaredWords('REGISTRY_ENTRY')[0]}`);
  return { root, indexer };
}

describe('hub DB sync explorer twin guard', () => {
  it('is an indexer CI drift tier with the explorer checkout required', () => {
    const ci = fs.readFileSync(path.join(repoRoot, 'bin', 'ci-full.sh'), 'utf8');
    assert.match(ci, /need_sib[^\n]*xchain-explorer/);
    assert.match(
      ci,
      /run_tier "drift: hub mirror explorer twins" bash bin\/sync-hub-mirror-client\.sh --check/,
    );
  });

  it('names both twin files when a canonical hub_db_sync part changes', () => {
    const fixture = twinFixture();
    try {
      const script = path.join(fixture.indexer, 'bin', 'sync-hub-mirror-client.sh');
      const clean = spawnSync('bash', [script, '--check'], { encoding: 'utf8' });
      assert.equal(clean.status, 0, clean.stdout + clean.stderr);

      fs.appendFileSync(
        path.join(fixture.indexer, 'src', 'hub', 'hub_db_sync', 'live_events.js'),
        'canonical change\n',
      );
      const drift = spawnSync('bash', [script, '--check'], { encoding: 'utf8' });
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
