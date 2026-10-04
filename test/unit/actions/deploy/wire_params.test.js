'use strict';

const assert = require('assert');

const { readWireParams } = require('../../../../src/actions/deploy/wire_params');

const PARAMS = ['x', 'p1', 'gas', 'c1', 'c2', 'c3', 'c4'];

describe('DEPLOY wire parameters', function () {
    it('reads format 0 as inline code with rest constructor parameters', function () {
        const data = {};
        const result = readWireParams(data, PARAMS, 0);

        assert.deepStrictEqual(data, {
            CODE_ENCODING: 'p1', GAS_LIMIT: 'gas',
            CONSTRUCTOR_PARAMS: ['c1', 'c2', 'c3', 'c4'].join(String.fromCharCode(124)),
            COOLDOWN_BLOCKS: null, SLASH_DESTINATION: null,
        });
        assert.deepStrictEqual(result, { isChunked: false, hasStaking: false });
    });

    it('reads format 1 as inline code with staking parameters', function () {
        const data = {};
        const result = readWireParams(data, PARAMS, 1);

        assert.deepStrictEqual(data, {
            CODE_ENCODING: 'p1', GAS_LIMIT: 'gas', CONSTRUCTOR_PARAMS: 'c1',
            COOLDOWN_BLOCKS: 'c2', SLASH_DESTINATION: 'c3',
        });
        assert.deepStrictEqual(result, { isChunked: false, hasStaking: true });
    });

    it('reads format 2 as chunked code with rest constructor parameters', function () {
        const data = {};
        const result = readWireParams(data, PARAMS, 2);

        assert.deepStrictEqual(data, {
            CODE_HASH_PARAM: 'p1', GAS_LIMIT: 'gas',
            CONSTRUCTOR_PARAMS: ['c1', 'c2', 'c3', 'c4'].join(String.fromCharCode(124)),
            COOLDOWN_BLOCKS: null, SLASH_DESTINATION: null,
        });
        assert.deepStrictEqual(result, { isChunked: true, hasStaking: false });
    });

    it('reads format 3 as chunked code with staking parameters', function () {
        const data = {};
        const result = readWireParams(data, PARAMS, 3);

        assert.deepStrictEqual(data, {
            CODE_HASH_PARAM: 'p1', GAS_LIMIT: 'gas', CONSTRUCTOR_PARAMS: 'c1',
            COOLDOWN_BLOCKS: 'c2', SLASH_DESTINATION: 'c3',
        });
        assert.deepStrictEqual(result, { isChunked: true, hasStaking: true });
    });
});
