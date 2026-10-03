'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const halt = require('../../../src/consensus/list_share_settle/halt.js');

const {
    ListShareHaltError,
    LIST_SHARE_HALT_REASON,
    LIST_SHARE_TX_PREFIX,
    LIST_SHARE_LEG_ORDINAL,
} = halt;

describe('list share halt vocabulary', function () {
    it('carries the halt identity and context on an Error', function () {
        const error = new ListShareHaltError(LIST_SHARE_HALT_REASON.QUORUM, 'ab12', 'not met');

        assert(error instanceof Error);
        assert.strictEqual(error.name, 'ListShareHaltError');
        assert.strictEqual(error.reason, 'QUORUM');
        assert.strictEqual(error.snapshot_id, 'ab12');
        assert.match(error.message, /QUORUM/);
        assert.match(error.message, /ab12/);
        assert.match(error.message, /not met/);
    });

    it('pins exactly the ten identity-valued halt reasons', function () {
        const names = [
            'SCREEN',
            'SEQ_GAP',
            'NO_HEIGHT',
            'QUORUM',
            'SNAPSHOT_ABSENT',
            'MEMBERS_HASH',
            'DELTA',
            'LEG',
            'NO_OWNER',
            'META_HASH',
        ];

        assert.deepStrictEqual(Object.keys(LIST_SHARE_HALT_REASON), names);
        assert(names.every((name) => LIST_SHARE_HALT_REASON[name] === name));
        assert(Object.isFrozen(LIST_SHARE_HALT_REASON));
    });

    it('keeps the synthetic transaction hash inside the unique prefix', function () {
        assert.strictEqual(LIST_SHARE_TX_PREFIX, 'LIST_SHARE-');
        assert.strictEqual(LIST_SHARE_TX_PREFIX.length, 11);
        assert(LIST_SHARE_TX_PREFIX.length + 48 <= 64);
    });

    it('pins frozen leg ordinals', function () {
        assert.deepStrictEqual(LIST_SHARE_LEG_ORDINAL, {
            CREATE_OR_REMOVE: 0,
            ADD:              1,
            META:             2,
        });
        assert(Object.isFrozen(LIST_SHARE_LEG_ORDINAL));
    });
});
