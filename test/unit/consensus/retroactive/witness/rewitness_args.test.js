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
 * Unit coverage for retroactive rewitness argument parsing.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const {
    parseGoArgs,
    parseRewitnessArgs,
    rewitnessCommand,
} = require('../../../../../src/consensus/retroactive/go_binding.js');

describe('retroactive rewitness arguments @regression @tier1', function () {
    it('parses --rewitness and --target in either order', function () {
        assert.deepStrictEqual(parseRewitnessArgs(['--rewitness', '--target', '9000']),
            { rewitness: true, target: 9000 });
        assert.deepStrictEqual(parseRewitnessArgs(['--target', '9000', '--rewitness']),
            { rewitness: true, target: 9000 });
    });

    it('accepts boundary target values', function () {
        assert.deepStrictEqual(parseRewitnessArgs(['--rewitness', '--target', '0']),
            { rewitness: true, target: 0 });
        assert.deepStrictEqual(parseRewitnessArgs([
            '--target', String(Number.MAX_SAFE_INTEGER), '--rewitness',
        ]), { rewitness: true, target: Number.MAX_SAFE_INTEGER });
    });

    it('refuses missing, repeated, unknown and malformed flags', function () {
        const refused = [
            [],
            ['--rewitness'],
            ['--target', '9000'],
            ['--rewitness', '--rewitness', '--target', '9'],
            ['--rewitness', '--target', '9', '--target', '10'],
            ['--rewitness', '--force', '9'],
            ['--rewitness', '--target', '-1'],
            ['--rewitness', '--target', '1.5'],
            ['--rewitness', '--target', String(Number.MAX_SAFE_INTEGER + 1)],
        ];
        for(const argv of refused)
            assert.throws(() => parseRewitnessArgs(argv), argv.join(' '));
    });

    it('leaves rewitness arguments invalid for the go parser', function () {
        assert.throws(() => parseGoArgs(['--rewitness', '--target', '9']));
    });

    it('prints the exact retroactive-go rewitness command', function () {
        assert.strictEqual(rewitnessCommand(9000),
            'node bin/retroactive-go.js --rewitness --target 9000');
    });
});
