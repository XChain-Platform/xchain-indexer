'use strict';

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
 *********************************************************************/

const assert = require('assert');
const {
    verifySigners,
    formatDropped
} = require('../../../../src/consensus/rollcall_close/signer_verify.js');

describe('formatDropped', function () {
    it('returns an empty string when every counter is zero', function () {
        const dropped = { no_row: 0, ledger_hash: 0, form: 0, sig: 0 };

        assert.strictEqual(formatDropped(dropped, false), '');
    });

    it('formats every counter and the epoch canonical version', function () {
        const dropped = { no_row: 1, ledger_hash: 2, form: 3, sig: 4 };

        assert.strictEqual(
            formatDropped(dropped, false),
            ' dropped[no_row=1 ledger_hash=2 form=3 sig=4 v0 epoch]'
        );
        assert.strictEqual(
            formatDropped(dropped, true),
            ' dropped[no_row=1 ledger_hash=2 form=3 sig=4 v1 epoch]'
        );
    });
});

describe('verifySigners', function () {
    it('tallies missing, mismatched, and invalid signer rows', function () {
        const answer = {
            signers: {
                a: { sig: 'aa', ledger_hash: 'AB' },
                b: { sig: 'bb', ledger_hash: 'cd' }
            }
        };

        const actual = verifySigners(answer, ['a', 'b', 'c'], new Map(), 'cd', 'regtest', 1);

        assert.strictEqual(actual.gatesActive, false);
        assert.deepStrictEqual(actual.presentKeys, []);
        assert.deepStrictEqual(actual.dropped, { no_row: 1, ledger_hash: 1, form: 0, sig: 1 });
    });
});
