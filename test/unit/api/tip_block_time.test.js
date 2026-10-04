/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 ********************************************************************/

'use strict';

const assert = require('assert');
const { tipBlockTime } = require('../../../src/api/tip_block_time');

function recordingDb(value) {
    const calls = [];
    return {
        calls,
        async getBlockTime(latest) {
            calls.push(latest);
            return value;
        }
    };
}

describe('tipBlockTime()', function () {
    it('returns numeric block times as numbers', async function () {
        const db = recordingDb(1712345678);
        assert.strictEqual(await tipBlockTime(db, 900), 1712345678);
        assert.deepStrictEqual(db.calls, [900]);
    });

    it('converts numeric-string block times to numbers', async function () {
        const db = recordingDb('1712345678');
        assert.strictEqual(await tipBlockTime(db, '900'), 1712345678);
        assert.deepStrictEqual(db.calls, ['900']);
    });

    it('returns null for the missing-block sentinel', async function () {
        const db = recordingDb(false);
        assert.strictEqual(await tipBlockTime(db, 900), null);
        assert.deepStrictEqual(db.calls, [900]);
    });

    it('returns null for a non-numeric block time', async function () {
        const latest = { height: 900 };
        const db = recordingDb('not-a-time');
        assert.strictEqual(await tipBlockTime(db, latest), null);
        assert.strictEqual(db.calls[0], latest);
    });
});
