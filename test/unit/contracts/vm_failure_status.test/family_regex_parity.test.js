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
 * Resource-family regex parity across the status mapping and both gas clamps
 *
 * util.vmFailureStatus collapses the resource family to one hashed status token, and
 * clampVmGas / settleConstructorOutcome clamp the same family's gasUsed to the ceiling.
 * A prefix added at one site only would split status_id from the fee across validators.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const SRC = path.join(__dirname, '../../../../src');

// The three sites that must carry the identical family regex literal
const SITES = [
    'utility/general.js',
    'actions/execute/settle.js',
    'actions/deploy/constructor_run.js'
];

// Pull every resource-family regex literal out of one source file
function familyLiterals(file){
    let text = fs.readFileSync(path.join(SRC, file), 'utf8');
    return text.match(/\/\^\(out_of_gas\|[^/\n]*\/[a-z]*/g) || [];
}

describe('VM failure family regex parity across status mapping and gas clamps @regression', function () {

    it('each site carries exactly one family regex literal', function () {
        for(let file of SITES)
            assert.strictEqual(familyLiterals(file).length, 1, file + ' family regex count');
    });

    it('the status mapping and both gas clamps use a byte-identical family regex', function () {
        let literals = SITES.map(file => familyLiterals(file)[0]);
        for(let i = 1; i < literals.length; i++)
            assert.strictEqual(literals[i], literals[0], SITES[i] + ' drifted from ' + SITES[0]);
    });
});
