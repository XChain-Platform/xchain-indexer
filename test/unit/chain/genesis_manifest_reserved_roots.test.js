'use strict';

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
 * test/unit/chain/genesis_manifest_reserved_roots.test.js
 *
 * The bundled mainnet genesis manifests hand out no reserved chain root.
 *
 * WHY: genesis rows are injected with IS_GENESIS, which the tick namespace guard
 * exempts, so a RESERVED_FUTURE_ROOTS name (or a ROOT.* child of one) that sat in a
 * manifest would get an owner on every node that bootstraps, past the very rule that
 * reserves it. The operator ruling of 2026-10-17 took BASE, DASH, HBAR, HOOD, HYPE
 * and NEAR away from their genesis holders so the bridges can own those roots; this
 * keeps any later manifest edit from handing one back.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { RESERVED_FUTURE_ROOTS, isReservedFutureRoot } = require('../../../src/consensus/reserved_roots.js');

const GENESIS_DIR = path.join(__dirname, '../../../data/genesis');
const MANIFESTS   = ['BTC-ledger.csv', 'DOGE-ledger.csv'];
const TAKEN_FROM_GENESIS = ['BASE', 'DASH', 'HBAR', 'HOOD', 'HYPE', 'NEAR'];

// The tick column of a manifest, header dropped. Rows read `"TICK",owner_address`.
function manifestTicks(file){
    const lines = fs.readFileSync(path.join(GENESIS_DIR, file), 'utf8').split(/\r?\n/);
    assert.strictEqual(lines[0].trim(), 'tick,owner_address', file + ' header moved; this reader needs updating');
    return lines.slice(1).filter(Boolean).map(l => l.split(',')[0].replace(/^"|"$/g, ''));
}

describe('genesis manifests carry no reserved chain root @regression @consensus', function(){

    for(const file of MANIFESTS){
        it(file + ' names no RESERVED_FUTURE_ROOTS root or child of one', function(){
            const ticks = manifestTicks(file);
            assert.ok(ticks.length > 40000, file + ' read as ' + ticks.length + ' rows; the manifest did not load');
            const held = ticks.filter(t => isReservedFutureRoot(t.split('.')[0]));
            assert.deepStrictEqual(held, [], file + ' hands a reserved root to a genesis holder');
        });
    }

    it('still reserves the six names taken out of the manifests', function(){
        for(const tick of TAKEN_FROM_GENESIS)
            assert.ok(RESERVED_FUTURE_ROOTS.includes(tick), tick + ' left RESERVED_FUTURE_ROOTS');
    });
});
