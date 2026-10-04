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
const {
    parseOracleContent,
    parseBatchContent
} = require('../../../../src/actions/slash/content_parsers.js');

const parsers = [parseOracleContent, parseBatchContent];
const nonObjects = ['{', 'null', '[]', '"value"', '5'];

describe('SLASH content parsers', function () {
    it('rejects unparseable JSON and JSON non-objects', function () {
        for(const parser of parsers){
            for(const content of nonObjects) assert.strictEqual(parser(content), null);
        }
    });

    it('reads oracle round and block height', function () {
        assert.deepStrictEqual(
            parseOracleContent('{"round":5,"btc_block_height":100}'),
            { round: 5, height: 100 }
        );
    });

    it('reads batch bounds and block height', function () {
        assert.deepStrictEqual(
            parseBatchContent('{"first_round":3,"last_round":5,"btc_block_height":100}'),
            { first: 3, last: 5, height: 100 }
        );
    });

    it('nulls only invalid oracle fields', function () {
        assert.deepStrictEqual(
            parseOracleContent('{"round":1.5,"btc_block_height":100}'),
            { round: null, height: 100 }
        );
        assert.deepStrictEqual(
            parseOracleContent('{"round":5,"btc_block_height":"100"}'),
            { round: 5, height: null }
        );
        assert.deepStrictEqual(parseOracleContent('{"round":5}'), { round: 5, height: null });
    });

    it('nulls only invalid batch fields', function () {
        assert.deepStrictEqual(
            parseBatchContent('{"first_round":1.5,"last_round":5,"btc_block_height":100}'),
            { first: null, last: 5, height: 100 }
        );
        assert.deepStrictEqual(
            parseBatchContent('{"first_round":3,"last_round":"5","btc_block_height":100}'),
            { first: 3, last: null, height: 100 }
        );
        assert.deepStrictEqual(
            parseBatchContent('{"first_round":3,"last_round":5}'),
            { first: 3, last: 5, height: null }
        );
    });

    it('stringifies non-string input before parsing', function () {
        const oracle = { toString: () => '{"round":5,"btc_block_height":100}' };
        const batch = {
            toString: () => '{"first_round":3,"last_round":5,"btc_block_height":100}'
        };
        assert.deepStrictEqual(parseOracleContent(oracle), { round: 5, height: 100 });
        assert.deepStrictEqual(parseBatchContent(batch), { first: 3, last: 5, height: 100 });
    });
});
