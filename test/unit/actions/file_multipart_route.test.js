/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const {
    MANIFEST_FORMAT,
    PART_FORMAT,
    multipartRoute,
    duplicateManifestVerdict,
} = require('../../../src/actions/file_multipart_route.js');

describe('FILE multipart routing', function(){
    it('exports the manifest and part wire formats exactly', function(){
        assert.strictEqual(MANIFEST_FORMAT,
            'VERSION|FILE_HASH|TOTAL_PARTS|TOTAL_BYTES|NAME|TYPE|TITLE|MEMO|GATE_TICKER|ENCRYPTION_METHOD|KEY_HASH|GATE_MIN_AMOUNT|COMPRESSION');
        assert.strictEqual(PART_FORMAT, 'VERSION|FILE_HASH|PART_INDEX');
    });

    for(const enabled of [false, true]){
        const side = enabled ? 'above activation' : 'below activation';

        it(`routes format 0 as legacy ${side}`, function(){
            assert.deepStrictEqual(multipartRoute(0, enabled, null), {
                route: 'legacy', error: null,
            });
        });

        it(`routes format 1 ${side}`, function(){
            assert.deepStrictEqual(multipartRoute(1, enabled, null), {
                route: enabled ? 'manifest' : 'unknown',
                error: enabled ? null : 'invalid: VERSION (unknown)',
            });
        });

        it(`routes format 2 ${side}`, function(){
            assert.deepStrictEqual(multipartRoute(2, enabled, null), {
                route: enabled ? 'part' : 'unknown',
                error: enabled ? null : 'invalid: VERSION (unknown)',
            });
        });
    }

    for(const format of [null, 3]){
        it(`rejects unknown format ${String(format)}`, function(){
            assert.deepStrictEqual(multipartRoute(format, true, null), {
                route: 'unknown', error: 'invalid: VERSION (unknown)',
            });
        });
    }

    it('preserves an incoming error on an unknown route', function(){
        assert.deepStrictEqual(multipartRoute(1, false, 'invalid: earlier'), {
            route: 'unknown', error: 'invalid: earlier',
        });
    });

    it('rejects a duplicate manifest for the same file hash', function(){
        assert.strictEqual(
            duplicateManifestVerdict(null, { file_hash: 'abc' }, 'abc'),
            'invalid: FILE_HASH (duplicate manifest)'
        );
    });

    it('accepts when no existing manifest is present', function(){
        assert.strictEqual(duplicateManifestVerdict(null, null, 'abc'), null);
    });

    it('accepts an existing manifest with a different hash', function(){
        assert.strictEqual(
            duplicateManifestVerdict(null, { file_hash: 'def' }, 'abc'),
            null
        );
    });

    it('preserves an incoming error over a duplicate manifest', function(){
        assert.strictEqual(
            duplicateManifestVerdict('invalid: earlier', { file_hash: 'abc' }, 'abc'),
            'invalid: earlier'
        );
    });
});
