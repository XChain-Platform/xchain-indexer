/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const FILES = [
    'src/actions/execute/run_vm.js',
    'src/consensus/gates/stake_weight_collation_gate.js',
    'src/db/actions.js',
    'src/db/contracts/index.js',
    'src/protocol_changes/shared_rows_4.js',
    'test/unit/state_commitment/db_state_key_collation.test.js',
];
const STALE_MODULE = /state_(?:commitment|key_collation)_activation\.js/;

function staleReferences(file) {
    return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => STALE_MODULE.test(line))
        .map(({ line, number }) => number + ': ' + line);
}

describe('stale state activation module references', function () {
    for (const file of FILES) {
        it(file + ' names neither retired activation module', function () {
            assert.deepStrictEqual(staleReferences(file), []);
        });
    }
});
