/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Prove every vendored copy of the shared activation-registry parts is
 * byte-identical to the indexer's current source.
 *
 * The parts under src/protocol_changes are canonical, and reconcile-twins.sh
 * copies them into five consumers. The consumer suites compare against a
 * pinned indexer commit or the documentation copy, so only a read of the
 * indexer's own tree catches an indexer-only edit before heights split.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const LOCAL_DIR = path.join(__dirname, '..', '..', '..', 'src', 'protocol_changes');
const PART_NAME = /^(regtest_env|shared_rows(_\d+)?)\.js$/;
// Keep in lockstep with the protocol_changes parts reconcile-twins.sh vendors.
const PARTS = [
    'regtest_env.js', 'shared_rows.js', 'shared_rows_1.js', 'shared_rows_2.js',
    'shared_rows_3.js', 'shared_rows_4.js', 'shared_rows_5.js',
];
const CONSUMERS = [
    '../../../../xchain-hub/src/consensus/gate_registry',
    '../../../../xchain-sync/src/consensus/gate_registry',
    '../../../../xchain-explorer/src/consensus/gate_registry',
    '../../../../xchain-sdk/src/consensus/gate_registry',
    '../../../../xchain-documentation/protocol/reference-impl/consensus/gate_registry',
];

function partsIn(dir) {
    return fs.readdirSync(dir).filter(f => PART_NAME.test(f)).sort();
}

function consumerName(rel) {
    return rel.split('/').find(seg => seg.startsWith('xchain-'));
}

describe('shared activation-registry parts: byte-identity to the indexer tree @regression', function() {
    it('the indexer part set is exactly the vendored part list', function() {
        assert.deepStrictEqual(partsIn(LOCAL_DIR), PARTS.slice().sort(),
            'src/protocol_changes registry parts changed; update PARTS here and the copy list in reconcile-twins.sh');
    });

    CONSUMERS.forEach(function(rel) {
        const name = consumerName(rel);
        it(name + ' carries every registry part byte-identical to the indexer', function() {
            const verdict = siblingCheckout(__dirname, rel);
            if(!verdict.usable) return skipOrFail(this, verdict, 'the ' + name + ' registry-parts byte-identity guard');
            const dir = verdict.path;
            assert.deepStrictEqual(partsIn(dir), PARTS.slice().sort(),
                name + ' registry part set differs from the indexer; re-vendor with reconcile-twins.sh --write');
            const drifted = PARTS.filter(f =>
                !fs.readFileSync(path.join(LOCAL_DIR, f)).equals(fs.readFileSync(path.join(dir, f))));
            assert.deepStrictEqual(drifted, [],
                name + ' copies drifted from xchain-indexer/src/protocol_changes: ' + drifted.join(', ')
                + '; edit the indexer copy and re-vendor with reconcile-twins.sh --write');
        });
    });
});
