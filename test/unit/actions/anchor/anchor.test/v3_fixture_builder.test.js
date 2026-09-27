// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const { vectors, v3Params } = require('./helpers/anchor_v3_fixtures.js');

const SEP = String.fromCharCode(124);

function wire(params) {
    return ['ANCHOR'].concat(params).join(SEP);
}

function differences(left, right) {
    const indexes = [];
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        if (left[i] !== right[i]) indexes.push(i);
    }
    return indexes;
}

describe('Anchor v3 fixture builder', function () {
    it('builds the archived canonical vector byte for byte', function () {
        assert.strictEqual(wire(v3Params()), vectors.vectors.v3);
    });

    it('builds the no-archive canonical vector byte for byte', function () {
        assert.strictEqual(wire(v3Params({ archive: false })), vectors.vectors.v3_no_archive);
    });

    it('supports an archive-only cycle', function () {
        const params = v3Params({ sections: [] });
        assert.deepStrictEqual(params.slice(0, 5), ['3', 'regtest', '100', '0', '1']);
        assert.strictEqual(params[5], '0');
    });

    it('changes only ARCHIVE_COUNT for its raw override', function () {
        const base = v3Params();
        const changed = v3Params({ archiveCount: '2' });
        const indexes = differences(base, changed);
        assert.strictEqual(indexes.length, 1);
        assert.strictEqual(base[indexes[0]], '1');
        assert.strictEqual(changed[indexes[0]], '2');
    });

    it('changes only WRAPPER_SECTION_INDEX for its raw override', function () {
        const base = v3Params();
        const changed = v3Params({ wrapperSectionIndex: '3' });
        const indexes = differences(base, changed);
        assert.strictEqual(indexes.length, 1);
        assert.strictEqual(base[indexes[0]], '0');
        assert.strictEqual(changed[indexes[0]], '3');
    });
});
