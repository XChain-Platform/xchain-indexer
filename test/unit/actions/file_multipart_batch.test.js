// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const { checkMultipartBatch } = require('../../../src/actions/file_multipart_validate.js');

function sibling(action) {
    return { action, params: [], raw: action };
}

describe('FILE multipart batch validation', function () {
    it('rejects a version 2 part in a BATCH even when its position is null', function () {
        const data = { VERSION: '2', BATCH_POSITION: null };
        assert.strictEqual(checkMultipartBatch(data, null), 'invalid: VERSION (batch)');
    });

    it('treats a BATCH_POSITION of zero as present', function () {
        const data = { VERSION: '2', BATCH_POSITION: 0 };
        assert.strictEqual(checkMultipartBatch(data, null), 'invalid: VERSION (batch)');
    });

    it('rejects a version 1 manifest beside another FILE', function () {
        const data = { VERSION: '1', SIBLING_ACTIONS: [sibling('FILE'), sibling('FILE')] };
        assert.strictEqual(checkMultipartBatch(data, null), 'invalid: FILE_HASH (batch)');
    });

    it('accepts a manifest with no SIBLING_ACTIONS', function () {
        assert.strictEqual(checkMultipartBatch({ VERSION: '1' }, null), null);
    });

    it('accepts a lone manifest beside a version 2 MESSAGE', function () {
        const message = { action: 'MESSAGE', params: ['2'], raw: 'MESSAGE|2' };
        const data = { VERSION: '1', SIBLING_ACTIONS: [sibling('FILE'), message] };
        assert.strictEqual(checkMultipartBatch(data, null), null);
    });

    it('accepts an unbatched version 2 part', function () {
        const data = { VERSION: '2', SIBLING_ACTIONS: [sibling('FILE')] };
        assert.strictEqual(checkMultipartBatch(data, null), null);
    });

    it('accepts a version 0 FILE in a BATCH beside another FILE', function () {
        const data = {
            VERSION: '0',
            BATCH_POSITION: 1,
            SIBLING_ACTIONS: [sibling('FILE'), sibling('FILE')],
        };
        assert.strictEqual(checkMultipartBatch(data, null), null);
    });

    it('preserves an incoming error before either multipart batch verdict', function () {
        const data = {
            VERSION: '2',
            BATCH_POSITION: 0,
            SIBLING_ACTIONS: [sibling('FILE'), sibling('FILE')],
        };
        assert.strictEqual(checkMultipartBatch(data, 'invalid: SOURCE'), 'invalid: SOURCE');
    });
});
