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
const { listShareSlashable } = require('../../../../../src/actions/slash/resolve_slot.js');

const prefix = ['EQUIV', 'XLISTSHARE', 'id', '0', '', ''].join('|');
const message = (field) => prefix + ['XLISTSHARE', 'id', field, 'DOGE'].join('|');

describe('SLASH list-share producer gate @regression', function () {
    it('accepts a regtest list-share at the genesis activation height', function () {
        assert.strictEqual(listShareSlashable(message('0'), prefix, 'regtest'), true);
    });

    it('rejects list-shares below the testnet producer height and while mainnet is unarmed', function () {
        // v0.21.1 arms the testnet producer at 154750; mainnet stays on the sentinel.
        assert.strictEqual(listShareSlashable(message('154749'), prefix, 'testnet'), false);
        assert.strictEqual(listShareSlashable(message('154750'), prefix, 'testnet'), true);
        assert.strictEqual(listShareSlashable(message('9999999998'), prefix, 'mainnet'), false);
    });

    it('rejects a non-numeric snapshot block', function () {
        assert.strictEqual(listShareSlashable(message('x1'), prefix, 'regtest'), false);
    });

    it('rejects content missing the snapshot-block field', function () {
        assert.strictEqual(listShareSlashable(prefix + 'XLISTSHARE|id', prefix, 'regtest'), false);
    });

    it('rejects a message outside the expected EQUIV prefix', function () {
        assert.strictEqual(listShareSlashable('XLISTSHARE|id|0', prefix, 'regtest'), false);
    });

    it('rejects a non-string message', function () {
        assert.strictEqual(listShareSlashable(null, prefix, 'regtest'), false);
    });
});
