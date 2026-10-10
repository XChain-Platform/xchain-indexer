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
 **********************************************************************
 *
 * Re-read the two code blocks of bin/pins/at1-consensus-identity.json from
 * this tree, and touch nothing else in the pin.
 *
 * WHY ONLY THE TWO BLOCKS. `bare_checkout` and `armed_regtest_venue` are what
 * bin/consensus-identity.js --json prints, bare and under the pin's own arming
 * levers; everything else in the pin (the notes, indexer_rev, the tip state
 * hash read on a rail) is a record somebody wrote and no tree can re-derive.
 * So a run on an unchanged tree writes back the same bytes, which is what lets
 * a landing regenerate the pin after a merge instead of asking for a rebase.
 *
 * WHAT IT KEEPS. Each block keeps the fields it already lists, in the order it
 * lists them, and the armed block keeps its `env` as written: the pin records
 * only the levers it armed, while a reading lists every lever with null for
 * the unset ones. The levers are read from that `env`, never restated here.
 *
 * USAGE (from the repo root)
 *   node bin/regenerate-identity-pin.js            rewrite the pin in place
 *   node bin/regenerate-identity-pin.js --check    exit 1 if a rewrite would change it
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const BIN  = path.join(REPO, 'bin', 'consensus-identity.js');
const PIN  = path.join(REPO, 'bin', 'pins', 'at1-consensus-identity.json');

// The child sees exactly the levers a block names and nothing else of this
// process's environment, so the caller's own arming never decides a reading.
function read(levers) {
    const res = spawnSync(process.execPath, [BIN, '--json'], { cwd: REPO, encoding: 'utf8', env: Object.assign({}, levers), maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) throw new Error(`bin/consensus-identity.js --json exited ${res.status}: ${res.stderr.trim()}`);
    return JSON.parse(res.stdout);
}

function refresh(block, reading) {
    for (const key of Object.keys(block)) {
        if (key === 'env') continue;
        if (!Object.prototype.hasOwnProperty.call(reading, key)) throw new Error(`the reading carries no ${key}`);
        block[key] = reading[key];
    }
}

function main(argv) {
    const before = fs.readFileSync(PIN, 'utf8');
    const pin = JSON.parse(before);
    const levers = {};
    for (const [name, value] of Object.entries(pin.armed_regtest_venue.env || {})) if (value !== null) levers[name] = value;
    refresh(pin.bare_checkout, read({}));
    refresh(pin.armed_regtest_venue, read(levers));
    const after = `${JSON.stringify(pin, null, 2)}\n`;
    if (argv.includes('--check')) {
        if (after !== before) { console.error('bin/pins/at1-consensus-identity.json: a regenerate would change it'); return 1; }
        return 0;
    }
    if (after !== before) fs.writeFileSync(PIN, after);
    return 0;
}

if (require.main === module) {
    try { process.exit(main(process.argv.slice(2))); } catch (err) { console.error(err.message); process.exit(2); }
}

module.exports = { refresh };
