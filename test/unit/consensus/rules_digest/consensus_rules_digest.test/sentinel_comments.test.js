/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const root = path.resolve(__dirname, '../../../../..');

describe('consensus rules digest sentinel comments', function () {
    it('names the shipped mainnet sentinel examples at the canonical constant', function () {
        const source = fs.readFileSync(path.join(root, 'src/consensus_rules_digest.js'), 'utf8');
        const comment = source.slice(
            source.lastIndexOf('// A per-network height', source.indexOf('const FAR_FUTURE_HEIGHT_SENTINEL')),
            source.indexOf('const FAR_FUTURE_HEIGHT_SENTINEL')
        );

        assert.ok(comment.includes(
            'TOKEN_BRIDGE_ACTIVATION.mainnet and LIST_META_ACTIVATION.mainnet are the live examples'
        ));
        assert.doesNotMatch(comment, /PRICE_PAIR_WIDEN_ACTIVATION\.mainnet/);
    });

    it('does not claim the shipped registry has no far-future sentinel', function () {
        const source = fs.readFileSync(path.join(__dirname, 'active_gates.test.js'), 'utf8');
        const comment = source.slice(
            source.lastIndexOf('// TOKEN_BRIDGE_ACTIVATION', source.indexOf("it('excludes a far-future sentinel height")),
            source.indexOf("it('excludes a far-future sentinel height")
        );

        assert.match(comment, /TOKEN_BRIDGE_ACTIVATION\.mainnet/);
        assert.match(comment, /LIST_META_ACTIVATION\.mainnet/);
        assert.doesNotMatch(comment, /left no SHIPPED gate/);
    });
});
