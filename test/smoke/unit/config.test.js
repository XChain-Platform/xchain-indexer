'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

describe('Smoke: config loading', function () {

    afterEach(function () {
        sinon.restore();
    });

    it('SM-01: loads config with valid INDEXER_COIN and INDEXER_NETWORK', function () {
        const config = require('../../../src/config.js');
        const cfg = config.getConfig();

        assert.strictEqual(cfg.COIN, 'BTC');
        assert.strictEqual(cfg.NETWORK, 'regtest');
        assert.strictEqual(cfg.GAS, 'XCHAIN');
        assert.ok(cfg.ADDRESS, 'ADDRESS should exist');
        assert.ok(cfg.ADDRESS.GAS, 'ADDRESS.GAS should be set');
        assert.strictEqual(typeof cfg.ISSUANCE_FEE_TOKEN, 'string');
        assert.strictEqual(typeof cfg.MAX_TOKEN_SUPPLY, 'string');
    });

    it('SM-02: throws when INDEXER_COIN is missing', function () {
        const saved = process.env.INDEXER_COIN;
        delete process.env.INDEXER_COIN;
        try {
            const config = require('../../../src/config.js');
            assert.throws(() => config.getConfig(), /Missing COIN config file/);
        } finally {
            process.env.INDEXER_COIN = saved;
        }
    });

    it('SM-03: throws when INDEXER_COIN points to nonexistent config', function () {
        const saved = process.env.INDEXER_COIN;
        process.env.INDEXER_COIN = 'INVALID';
        try {
            const config = require('../../../src/config.js');
            assert.throws(() => config.getConfig(), /Missing COIN config file/);
        } finally {
            process.env.INDEXER_COIN = saved;
        }
    });

});
