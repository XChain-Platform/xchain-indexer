'use strict';

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
