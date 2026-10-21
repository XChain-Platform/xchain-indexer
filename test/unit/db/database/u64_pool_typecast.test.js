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
const { connectionPoolParams } = require('../../../../src/db/database/instance_state.js');

describe('database pool exact u64 typeCast @regression @tier1', function () {
    const params = connectionPoolParams({
        host: 'h',
        port: 3306,
        user: 'u',
        pass: 'p',
        dbName: 'd',
    });
    const bigint = (value) => ({ type: 'BIGINT', string: () => value });

    it('keeps the unsigned 64-bit maximum as an exact decimal string', function () {
        assert.strictEqual(
            params.typeCast(bigint('18446744073709551615'), () => assert.fail('unexpected fallback')),
            '18446744073709551615'
        );
    });

    it('returns safe BIGINT values as Numbers', function () {
        assert.strictEqual(
            params.typeCast(bigint('42'), () => assert.fail('unexpected fallback')),
            42
        );
        assert.strictEqual(
            params.typeCast(bigint(String(Number.MAX_SAFE_INTEGER)),
                () => assert.fail('unexpected fallback')),
            Number.MAX_SAFE_INTEGER
        );
    });

    it('preserves SQL null without invoking the connector fallback', function () {
        assert.strictEqual(
            params.typeCast(bigint(null), () => assert.fail('unexpected fallback')),
            null
        );
    });

    it('delegates every non-BIGINT field to the connector', function () {
        const sentinel = Symbol('connector value');
        let calls = 0;
        const value = params.typeCast({ type: 'VARCHAR' }, () => {
            calls += 1;
            return sentinel;
        });

        assert.strictEqual(value, sentinel);
        assert.strictEqual(calls, 1);
    });
});
