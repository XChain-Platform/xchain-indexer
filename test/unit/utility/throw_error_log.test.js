'use strict';

const assert = require('assert');

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const observability = require('../../../src/observability/index.js');
const Utility = require('../../../src/utility.js');

describe('Utility throwError()', function () {
    let errorLines;

    beforeEach(function () {
        errorLines = [];
        observability._resetObservability();
        observability.installObservability(null, {
            service: 'xchain-indexer',
            env: {},
            console: {
                log() {},
                warn() {},
                error(line) { errorLines.push(line); }
            }
        });
    });

    afterEach(function () {
        observability._resetObservability();
    });

    it('includes an Error message in the rendered refusal log and rethrows the same Error', function () {
        const util = new Utility();
        const refusal = new Error('consensus gate height moved at or below applied tip');

        assert.throws(
            () => util.throwError(refusal),
            (thrown) => thrown === refusal
        );
        assert.strictEqual(errorLines.length, 1);
        assert.match(errorLines[0], /throwError: consensus gate height moved at or below applied tip/);
    });

    it('stringifies a non-Error refusal in the rendered log', function () {
        const util = new Utility();

        assert.throws(
            () => util.throwError('decoder database is unavailable'),
            /decoder database is unavailable/
        );
        assert.strictEqual(errorLines.length, 1);
        assert.match(errorLines[0], /throwError: decoder database is unavailable/);
    });
});
