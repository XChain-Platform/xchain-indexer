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
 * The top-level EXECUTE gas ceiling is stated three times: GAS_CEILING in
 * actions/execute/index.js (the host LIMITS, module-private), gasCeiling in
 * the actions/index.js VM options, and the constructor clamp in
 * actions/deploy/constants.js. Changing one alone forks validators, so this
 * pins all three to one value. The two module-private copies are read as
 * source with the same one-literal shape a sibling repo's parity gate scrapes.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const GOLDEN_GAS_CEILING = 1000000;
const SRC = path.join(__dirname, '../../../src/actions');

// Read the one literal a source states for a key, failing loud on any other shape.
function scrapeOne(rel, re){
    const hits = [...fs.readFileSync(path.join(SRC, rel), 'utf8').matchAll(re)];
    assert.strictEqual(hits.length, 1, rel + ': expected exactly one gas ceiling literal, found ' + hits.length);
    return Number(hits[0][1]);
}

describe('top-level gas ceiling parity across its three indexer copies @regression @tier1', function(){
    it('the deploy constructor clamp holds the golden ceiling', function(){
        const { GAS_CEILING } = require('../../../src/actions/deploy/constants.js');
        assert.strictEqual(GAS_CEILING, GOLDEN_GAS_CEILING);
    });

    it('the execute host limit and the VM construction option match the deploy clamp', function(){
        const { GAS_CEILING } = require('../../../src/actions/deploy/constants.js');
        const copies = [
            ['execute/index.js', /^const GAS_CEILING = (\d+);/gm],
            ['index.js',         /^\s*gasCeiling:\s*(\d+),/gm]
        ];
        for(const [rel, re] of copies)
            assert.strictEqual(scrapeOne(rel, re), GAS_CEILING,
                'src/actions/' + rel + ' disagrees with deploy/constants.js; move every copy together');
    });
});
