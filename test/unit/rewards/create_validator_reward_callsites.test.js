/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/rewards/create_validator_reward_callsites.test.js
 *
 * Census of production createValidatorReward call sites.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const EXPECTED = {
    'actions/attest/settle.js':                   { calls: 2, bound: 0 },
    'consensus/anchor_reward_derive/mint_row.js': { calls: 1, bound: 0 },
    'consensus/rollcall_close.js':                { calls: 1, bound: 0 },
};

function walk(dir, out) {
    for(const entry of fs.readdirSync(dir, { withFileTypes: true })){
        const file = path.join(dir, entry.name);
        if(entry.isDirectory()) walk(file, out);
        else if(entry.name.endsWith('.js')) out.push(file);
    }
    return out;
}

describe('createValidatorReward call-site census @regression @tier1', function () {

    it('matches the known set of call sites', function () {
        const found = {};
        for(const file of walk(SRC, [])){
            const relative = path.relative(SRC, file).split(path.sep).join('/');
            if(relative === 'db/rewards/index.js') continue;
            const source = fs.readFileSync(file, 'utf8');
            const calls  = (source.match(/\.createValidatorReward\(/g) || []).length;
            const bound  = (source.match(/\.createValidatorReward\.bind\(/g) || []).length;
            if(calls + bound > 0) found[relative] = { calls, bound };
        }
        assert.deepStrictEqual(found, EXPECTED);
    });

    it('names rollcall_publish as a derive_block_index writer', function () {
        const source = fs.readFileSync(path.join(SRC, 'consensus', 'rollcall_close.js'), 'utf8');
        assert.ok(/'rollcall_publish',[^;]*?true,\s*closeBlock/.test(source),
            'rollcall_publish must stamp derive_block_index with the close block');
    });
});
