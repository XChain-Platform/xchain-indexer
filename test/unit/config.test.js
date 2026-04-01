const assert = require('assert');

describe('Config @regression @tier3', function () {

    beforeEach(function () {
        // Clear require cache so config reloads with new env
        delete require.cache[require.resolve('../../src/config.js')];
    });

    describe('getConfig() — BTC', function () {
        let config;

        before(function () {
            process.env.INDEXER_COIN = 'BTC';
            process.env.INDEXER_NETWORK = 'regtest';
            delete require.cache[require.resolve('../../src/config.js')];
            config = require('../../src/config.js').getConfig();
        });

        it('should set COIN to BTC', function () {
            assert.strictEqual(config.COIN, 'BTC');
        });

        it('should set NETWORK to regtest', function () {
            assert.strictEqual(config.NETWORK, 'regtest');
        });

        it('should set GAS to XCHAIN', function () {
            assert.strictEqual(config.GAS, 'XCHAIN');
        });

        it('should include all three coins', function () {
            assert.deepStrictEqual(config.COINS, ['BTC', 'LTC', 'DOGE']);
        });

        it('should set NATIVE_TICK to BTC', function () {
            assert.strictEqual(config.NATIVE_TICK, 'BTC');
            assert.strictEqual(config.NATIVE_TICK_DECIMALS, 8);
        });

        it('should reserve coin names and gas token', function () {
            assert.ok(config.RESERVED_TICKS.includes('BTC'));
            assert.ok(config.RESERVED_TICKS.includes('LTC'));
            assert.ok(config.RESERVED_TICKS.includes('DOGE'));
            assert.ok(config.RESERVED_TICKS.includes('XCHAIN'));
        });

        it('should set tick length constraints', function () {
            assert.strictEqual(config.MIN_TICK_LENGTH, 1);
            assert.strictEqual(config.MAX_TICK_LENGTH, 250);
        });

        it('should set token decimal range', function () {
            assert.strictEqual(config.MIN_TOKEN_DECIMALS, 0);
            assert.strictEqual(config.MAX_TOKEN_DECIMALS, 18);
        });

        it('should set token supply range as strings', function () {
            assert.strictEqual(config.MIN_TOKEN_SUPPLY, '0.000000000000000001');
            assert.strictEqual(config.MAX_TOKEN_SUPPLY, '1000000000000000000000');
        });

        it('should set BTC-specific issuance fees', function () {
            assert.strictEqual(config.ISSUANCE_FEE_TOKEN, '1.00000000');
            assert.strictEqual(config.ISSUANCE_FEE_SUBTOKEN, '0.50000000');
        });

        it('should set expiration fee config', function () {
            assert.strictEqual(config.EXPIRATION_FEE_DEFAULT_DAYS, 90);
            assert.strictEqual(config.EXPIRATION_FEE_FREE_DAYS, 182);
            assert.strictEqual(config.EXPIRATION_FEE_PER_DAY, '0.00547945');
        });

        it('should set BTC regtest addresses', function () {
            assert.ok(config.ADDRESS);
            assert.ok(config.ADDRESS.BURN);
            assert.ok(config.ADDRESS.GAS);
            assert.ok(config.ADDRESS.DONATE1);
            assert.ok(config.ADDRESS.DONATE2);
        });

        it('should define field length limits', function () {
            assert.strictEqual(config.MAX_TOKEN_DESCRIPTION, 250);
            assert.strictEqual(config.MAX_MEMO_LENGTH, 250);
            assert.strictEqual(config.MAX_FILE_NAME_LENGTH, 250);
            assert.strictEqual(config.MAX_FILE_TYPE_LENGTH, 255);
            assert.strictEqual(config.MAX_BROADCAST_MESSAGE_LENGTH, 250);
            assert.strictEqual(config.MAX_BROADCAST_VALUE_LENGTH, 25);
        });

        it('should define NUMBER_FIELDS list', function () {
            assert.ok(Array.isArray(config.NUMBER_FIELDS));
            assert.ok(config.NUMBER_FIELDS.includes('AMOUNT'));
            assert.ok(config.NUMBER_FIELDS.includes('DECIMALS'));
            assert.ok(config.NUMBER_FIELDS.includes('MAX_SUPPLY'));
        });

        it('should define LOCK_FIELDS list', function () {
            assert.ok(Array.isArray(config.LOCK_FIELDS));
            assert.ok(config.LOCK_FIELDS.includes('LOCK_MAX_SUPPLY'));
            assert.ok(config.LOCK_FIELDS.includes('LOCK_MINT'));
            assert.strictEqual(config.LOCK_FIELDS.length, 7);
        });

        it('should define LIST_FIELDS', function () {
            assert.deepStrictEqual(config.LIST_FIELDS, ['ALLOW_LIST', 'BLOCK_LIST']);
        });

        it('should define FIATS dictionary', function () {
            assert.ok(config.FIATS.USD);
            assert.ok(config.FIATS.JPY);
            assert.strictEqual(Object.keys(config.FIATS).length, 10);
        });

        it('should set message encryption methods', function () {
            assert.deepStrictEqual(config.MESSAGE_ENCRYPTION_METHODS, [1, 2]);
        });

        it('should set sleep immediate methods', function () {
            assert.deepStrictEqual(config.SLEEP_IMMEDIATE_METHODS, [-1, 0]);
        });

        it('should set block check interval', function () {
            assert.strictEqual(config.BLOCK_CHECK_INTERVAL, 5000);
        });

        it('should set dispenser delays', function () {
            assert.strictEqual(config.DISPENSER_LIST_DELAY, 3600);
            assert.strictEqual(config.DISPENSER_CLOSE_DELAY, 3600);
        });

        it('should set max dispenses', function () {
            assert.strictEqual(config.MAX_DISPENSES, 1000);
        });

        it('should define TICK_CHARACTERS', function () {
            assert.ok(config.TICK_CHARACTERS.includes('A'));
            assert.ok(config.TICK_CHARACTERS.includes('z'));
            assert.ok(config.TICK_CHARACTERS.includes('0'));
        });
    });

    describe('getConfig() — LTC', function () {
        let config;

        before(function () {
            process.env.INDEXER_COIN = 'LTC';
            process.env.INDEXER_NETWORK = 'regtest';
            delete require.cache[require.resolve('../../src/config.js')];
            // Also clear the coin config cache
            try { delete require.cache[require.resolve('../../src/configs/LTC.js')]; } catch (e) {}
            config = require('../../src/config.js').getConfig();
        });

        it('should set COIN to LTC', function () {
            assert.strictEqual(config.COIN, 'LTC');
        });

        it('should set LTC-specific issuance fees (half of BTC)', function () {
            assert.strictEqual(config.ISSUANCE_FEE_TOKEN, '0.50000000');
            assert.strictEqual(config.ISSUANCE_FEE_SUBTOKEN, '0.25000000');
        });

        it('should set NATIVE_TICK to LTC', function () {
            assert.strictEqual(config.NATIVE_TICK, 'LTC');
        });
    });

    describe('getConfig() — DOGE', function () {
        let config;

        before(function () {
            process.env.INDEXER_COIN = 'DOGE';
            process.env.INDEXER_NETWORK = 'regtest';
            delete require.cache[require.resolve('../../src/config.js')];
            try { delete require.cache[require.resolve('../../src/configs/DOGE.js')]; } catch (e) {}
            config = require('../../src/config.js').getConfig();
        });

        it('should set COIN to DOGE', function () {
            assert.strictEqual(config.COIN, 'DOGE');
        });

        it('should set DOGE-specific issuance fees (quarter of BTC)', function () {
            assert.strictEqual(config.ISSUANCE_FEE_TOKEN, '0.25000000');
            assert.strictEqual(config.ISSUANCE_FEE_SUBTOKEN, '0.10000000');
        });

        it('should set NATIVE_TICK to DOGE', function () {
            assert.strictEqual(config.NATIVE_TICK, 'DOGE');
        });
    });

    describe('getConfig() — invalid coin', function () {
        it('should throw for missing coin config file', function () {
            process.env.INDEXER_COIN = 'ETH';
            process.env.INDEXER_NETWORK = 'regtest';
            delete require.cache[require.resolve('../../src/config.js')];
            assert.throws(() => require('../../src/config.js').getConfig(), /Missing COIN config/);
        });
    });
});
