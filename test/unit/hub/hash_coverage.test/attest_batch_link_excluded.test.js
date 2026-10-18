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
 **********************************************************************/

'use strict';

const assert = require('assert');

const lifecycle = require('../../../../src/hub/table_lifecycle.js');

describe('Hash coverage guard @regression', function () {
    describe('attests batch display link parity', function () {
        it('excludes batch_action_index by design while retaining later-block callback coverage', function () {
            assert.deepStrictEqual(lifecycle.CONTENT_PARITY_EXCLUDED_COLUMNS.attests,
                ['batch_action_index']);
            assert.ok(!lifecycle.CONTENT_PARITY_IN_PLACE_COLUMNS.attests.includes('batch_action_index'));
            assert.ok(lifecycle.CONTENT_PARITY_IN_PLACE_COLUMNS.attests
                .includes('callback_execute_action_index'));
            assert.deepStrictEqual(lifecycle.contentParityExcludedColumns('attests'), [
                'batch_action_index',
                'request_status',
                'resolved_block',
                'callback_execute_action_index',
                'status_id',
            ]);
        });
    });
});
