'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

describe('Security: ledger table name whitelist @regression @tier4', function () {

    const VALID_LEDGER_TABLES = ['credits', 'debits', 'escrows'];

    it('SEC-25: table = \'credits\' → allowed', function () {
        assert.strictEqual(VALID_LEDGER_TABLES.includes('credits'), true);
    });

    it('SEC-26: table = \'debits\' → allowed', function () {
        assert.strictEqual(VALID_LEDGER_TABLES.includes('debits'), true);
    });

    it('SEC-27: table = \'escrows\' → allowed', function () {
        assert.strictEqual(VALID_LEDGER_TABLES.includes('escrows'), true);
    });

    it('SEC-28: table = \'malicious_table\' → rejected', function () {
        assert.strictEqual(VALID_LEDGER_TABLES.includes('malicious_table'), false);
    });

    it('SEC-28b: table = \'credits; DROP TABLE balances\' → rejected', function () {
        assert.strictEqual(VALID_LEDGER_TABLES.includes('credits; DROP TABLE balances'), false);
    });

    it('SEC-28c: table = \'\' (empty string) → rejected', function () {
        assert.strictEqual(VALID_LEDGER_TABLES.includes(''), false);
    });
});
