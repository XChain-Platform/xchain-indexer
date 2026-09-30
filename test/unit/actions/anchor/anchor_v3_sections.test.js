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
const validate = require('../../../../src/actions/anchor/validate.js');
const { walkFoldSections } = require('../../../../src/actions/anchor/v3_sections.js');
const { splitV3Wire } = require('../../../../src/actions/anchor/v3_wire.js');
const {
    vectors,
    v3Params
} = require('./anchor.test/helpers/anchor_v3_fixtures.js');

const handler = {
    validateSectionShape(section, seenChains){
        return validate.sectionShapeReason(section, seenChains);
    }
};

function splitFor(options){
    const split = splitV3Wire(v3Params(options));
    assert.strictEqual(split.error, undefined);
    return split;
}

function walk(options, dataOverrides, error){
    const split = splitFor(options);
    const data = Object.assign({}, split.header, dataOverrides);
    return walkFoldSections(handler, split, data, error);
}

function expectedSections(){
    return vectors.fixture.bundle_v3.sections
        .slice()
        .sort((left, right) => left.chain.localeCompare(right.chain))
        .map(section => ({
            CHAIN: section.chain,
            CHECKPOINT_SEQ: String(section.checkpoint_seq),
            SIGS: section.validator_signatures
                .slice()
                .sort((left, right) => left.pubkey.localeCompare(right.pubkey))
        }));
}

describe('ANCHOR v3 section walk', function(){
    it('walks fixture sections in wire order', function(){
        const result = walk();

        assert.strictEqual(result.error, undefined);
        assert.deepStrictEqual(result.sections.map(section => ({
            CHAIN: section.CHAIN,
            CHECKPOINT_SEQ: section.CHECKPOINT_SEQ,
            SIGS: section.SIGS
        })), expectedSections());
    });

    it('accepts an archive-only cycle with no checkpoint sections', function(){
        const result = walk({ sections: [], archive: false });

        assert.strictEqual(result.error, undefined);
        assert.deepStrictEqual(result.sections, []);
    });

    it('refuses a duplicated chain at the later section', function(){
        const fixture = vectors.fixture.bundle_v3.sections;
        const sections = [fixture[1], Object.assign({}, fixture[1])];
        const result = walk({ sections });

        assert.strictEqual(result.error, 'invalid: SECTION 1 CHAIN (duplicate)');
        assert.deepStrictEqual(result.sections.map(section => section.CHAIN), ['BTC']);
    });

    it('refuses a header snapshot above the section maximum', function(){
        const result = walk(undefined, { SNAPSHOT_BLOCK: '101' });

        assert.strictEqual(result.error,
            'invalid: SNAPSHOT_BLOCK (not the section maximum)');
        assert.strictEqual(result.sections.length, 3);
    });

    it('passes an incoming error through without walking sections', function(){
        const incoming = 'invalid: prior split failure';
        const result = walk(undefined, undefined, incoming);

        assert.deepStrictEqual(result, { error: incoming, sections: [] });
    });
});
