/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Unit coverage for the canonical retroactive-go command binding.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('node:crypto');
const {
    RETRO_GO_CODE,
    goRulesSha,
    goCommand,
    parseGoArgs,
    goAuthorizes,
} = require('../../../../src/consensus/retroactive/go_binding.js');

const MAP = '{"BTC":{"regtest":0}}';
const TARGET = 77;
const RULES = crypto.createHash('sha256')
    .update(MAP + '\n' + String(TARGET))
    .digest('hex');

describe('retroactive go binding @regression @tier1', function () {
    it('publishes the retroactive go code', function () {
        assert.strictEqual(RETRO_GO_CODE, 'CONSENSUS_RETRO_GO');
    });

    it('hashes the canonical map, newline and target against node:crypto', function () {
        assert.strictEqual(goRulesSha(MAP, TARGET), RULES);
    });

    it('prints the exact retroactive-go command', function () {
        assert.strictEqual(goCommand(TARGET, RULES),
            'node bin/retroactive-go.js --target 77 --rules ' + RULES);
    });

    it('parses --target and --rules in either order', function () {
        assert.deepStrictEqual(parseGoArgs(['--target', '77', '--rules', RULES]),
            { target: TARGET, rules: RULES });
        assert.deepStrictEqual(parseGoArgs(['--rules', RULES, '--target', '77']),
            { target: TARGET, rules: RULES });
    });

    it('refuses missing, repeated, unknown and malformed flags', function () {
        const refused = [
            ['--target', '77'],
            ['--target', '77', '--target', '78'],
            ['--target', '77', '--force', RULES],
            ['--target', '-1', '--rules', RULES],
            ['--target', '1.5', '--rules', RULES],
            ['--target', String(Number.MAX_SAFE_INTEGER + 1), '--rules', RULES],
            ['--target', '77', '--rules', RULES.toUpperCase()],
            ['--target', '77', '--rules', 'zz'],
        ];
        for(const argv of refused)
            assert.throws(() => parseGoArgs(argv), argv.join(' '));
    });

    it('authorizes only the exact map and target binding', function () {
        const goRow = { target: TARGET, rules: RULES };
        assert.strictEqual(goAuthorizes(goRow, { canonicalMap: MAP, target: TARGET }), true);
        assert.strictEqual(goAuthorizes(goRow, { canonicalMap: MAP + '\n', target: TARGET }), false);
        assert.strictEqual(goAuthorizes({ target: TARGET + 1, rules: RULES },
            { canonicalMap: MAP, target: TARGET }), false);
        assert.strictEqual(goAuthorizes(goRow, { canonicalMap: MAP, target: TARGET + 1 }), false);
        assert.strictEqual(goAuthorizes({ target: TARGET + 1, rules: RULES },
            { canonicalMap: MAP, target: TARGET + 1 }), false);
    });
});
