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
const { execFileSync } = require('node:child_process');

const DEFAULT_INDEXER = path.resolve(__dirname, '..');
const HUB_DB_SYNC_PATH = /^src\/hub\/hub_db_sync(?:\.js|\/.*\.js)$/;

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function isCommit(root, revision) {
  try {
    git(root, ['cat-file', '-e', `${revision}^{commit}`]);
    return true;
  } catch (_error) {
    return false;
  }
}

function resolveBase(root, requested) {
  if (requested && isCommit(root, requested)) return requested;
  try {
    return git(root, ['merge-base', 'HEAD', 'origin/develop']) || null;
  } catch (_error) {
    return null;
  }
}

function changedHubDbSyncFiles(root, base) {
  const output = execFileSync(
    'git',
    ['-C', root, 'diff', '--no-renames', '--name-only', '-z', `${base}...HEAD`],
  );
  return output.toString('utf8').split('\0').filter((file) => HUB_DB_SYNC_PATH.test(file));
}

function sameFile(left, right) {
  if (!fs.existsSync(left) || !fs.existsSync(right)) {
    return !fs.existsSync(left) && !fs.existsSync(right);
  }
  return fs.readFileSync(left).equals(fs.readFileSync(right));
}

function companionRef(spec, sibling) {
  let fallback = null;
  const explicit = [];
  for (const token of String(spec || '').split(/[\s,;]+/)) {
    if (!token || token.startsWith('#')) continue;
    const separator = token.indexOf('=');
    const name = separator === -1 ? token : token.slice(0, separator);
    const revision = separator === -1 ? 'HEAD' : token.slice(separator + 1) || 'HEAD';
    if (name === '*' || name.toLowerCase() === 'all') fallback = revision;
    else explicit.push([name, revision]);
  }
  const match = explicit.find(([name]) => name === sibling);
  return match ? match[1] : fallback;
}

function fileAtRevision(root, revision, relative) {
  try {
    return execFileSync('git', ['-C', root, 'show', `${revision}:${relative}`]);
  } catch (_error) {
    return null;
  }
}

function sameFileAtRevision(left, rightRoot, revision, relative) {
  if (!fs.existsSync(left)) return fileAtRevision(rightRoot, revision, relative) === null;
  const right = fileAtRevision(rightRoot, revision, relative);
  return right !== null && fs.readFileSync(left).equals(right);
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--base' || !args[index + 1]) {
      throw new Error('usage: check-hub-db-sync-explorer-twins.js [--base SHA]');
    }
    options.base = args[index + 1];
    index += 1;
  }
  return options;
}

function main(args = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  const indexer = path.resolve(env.XCHAIN_INDEXER_PATH || DEFAULT_INDEXER);
  const explorer = path.resolve(
    env.XCHAIN_EXPLORER_PATH || path.join(indexer, '..', 'xchain-explorer'),
  );
  const explorerRef =
    companionRef(env.CI_SIBLING_PINS, path.basename(explorer)) ||
    companionRef(env.CI_COMPANIONS, path.basename(explorer));
  if (explorerRef && !isCommit(explorer, explorerRef)) {
    console.error(
      `hub_db_sync twin guard: companion ref ${explorerRef} does not resolve in ` +
        path.basename(explorer),
    );
    return 2;
  }
  const requestedBase = options.base || env.PROM_CI_BASE_SHA;
  const base = resolveBase(indexer, requestedBase);
  if (!base) {
    console.error('hub_db_sync twin guard: no valid push base or origin/develop merge-base');
    return 2;
  }

  let changed;
  try {
    changed = changedHubDbSyncFiles(indexer, base);
  } catch (error) {
    console.error(`hub_db_sync twin guard: could not inspect ${base}...HEAD: ${error.message}`);
    return 2;
  }

  let drift = false;
  for (const file of changed) {
    const matches = explorerRef
      ? sameFileAtRevision(path.join(indexer, file), explorer, explorerRef, file)
      : sameFile(path.join(indexer, file), path.join(explorer, file));
    if (!matches) {
      console.log(
        `DRIFT: ${path.basename(explorer)}/${file} differs from canonical ` +
          `${path.basename(indexer)}/${file}`,
      );
      drift = true;
    }
  }
  if (drift) return 1;

  console.log(
    changed.length
      ? `OK: ${changed.length} changed canonical hub_db_sync explorer twin(s) are byte-identical` +
        `${explorerRef ? ` at companion ref ${explorerRef}` : ''}.`
      : 'OK: no canonical hub_db_sync files changed in the pushed range.',
  );
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  changedHubDbSyncFiles,
  companionRef,
  fileAtRevision,
  main,
  resolveBase,
  sameFile,
  sameFileAtRevision,
};
