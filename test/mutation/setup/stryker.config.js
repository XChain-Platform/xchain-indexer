// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const path = require('node:path');

const mocha12Compat = path.join(__dirname, 'mocha_12_compat.cjs');
require(mocha12Compat);
// Every Stryker worker discovers plugins, not only the workers that run tests.
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require=${mocha12Compat}`.trim();

module.exports = {
    mutate: [
        'src/utility/fees.js',
        'src/db/balances/index.js',
        'src/consensus/state_hash.js',
        'src/consensus/state_hash/**/*.js',
    ],
    testRunner: 'mocha',
    mochaOptions: {
        'no-config': true,
        require: ['./test/helpers/setup.js'],
        spec: [
            'test/unit/utility/utility.test/fees_and_transforms.test.js',
            'test/unit/db/update_address_balance.test.js',
            'test/unit/consensus/state_hash.test/**/*.test.js',
            'test/unit/state_commitment/state_hash/**/*.test.js',
        ],
    },
    coverageAnalysis: 'perTest',
    ignorePatterns: ['tmp', 'xchain-vm'],
    timeoutMS: 30000,
    reporters: ['clear-text', 'html', 'json'],
    htmlReporter: {
        fileName: 'tmp/mutation-report/index.html',
    },
    jsonReporter: {
        fileName: 'tmp/mutation-report/mutation.json',
    },
    tempDirName: 'tmp/stryker',
    thresholds: {
        high: 80,
        low: 60,
        break: null,
    },
};
