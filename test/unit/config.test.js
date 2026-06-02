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
            assert.strictEqual(Object.keys(config.FIATS).length, 12);
        });

        it('should set message encryption methods', function () {
            assert.deepStrictEqual(config.MESSAGE_ENCRYPTION_METHODS, [1, 2, 3]);
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

// ---------------------------------------------------------------------------
// Hub config overlay (_applyHubConfigOverlay)
// ---------------------------------------------------------------------------

describe('XChainIndexer hub config overlay', function () {
    const sinon = require('sinon');

    let indexer;

    function makeIndexer(){
        const XChainIndexer = require('../../src/XChainIndexer.js');
        let inst = new XChainIndexer(
            'dhost', 3306, 'ddb', 'duser', 'dpass',
            'ihost', 3306, 'idb', 'iuser', 'ipass',
            null, null, null, null, null,
            null, null
        );
        process.env.INDEXER_COIN    = 'BTC';
        process.env.INDEXER_NETWORK = 'regtest';
        delete require.cache[require.resolve('../../src/config.js')];
        inst.config = require('../../src/config.js').getConfig();
        return inst;
    }

    afterEach(function () {
        sinon.restore();
        delete require.cache[require.resolve('../../src/XChainIndexer.js')];
    });

    it('overrides GAS_PRICE with hub-served value', async function () {
        indexer = makeIndexer();
        let localPrice = indexer.config.GAS_PRICE;

        // stub the hub client's _call to return a higher GAS_PRICE
        let hubStub = { enabled: true, _call: sinon.stub().resolves({
            BTC: { regtest: { 'xchain-indexer': { GAS_PRICE: '0.00099' } } }
        })};
        indexer.hubClient = hubStub;

        await indexer._applyHubConfigOverlay();

        assert.strictEqual(indexer.config.GAS_PRICE, '0.00099');
        assert.notStrictEqual(indexer.config.GAS_PRICE, localPrice);
    });

    it('falls back gracefully when hub is unreachable', async function () {
        indexer = makeIndexer();
        let localPrice = indexer.config.GAS_PRICE;

        let hubStub = { enabled: true, _call: sinon.stub().rejects(new Error('ECONNREFUSED')) };
        indexer.hubClient = hubStub;

        // Should not throw
        await indexer._applyHubConfigOverlay();

        // Local default is preserved
        assert.strictEqual(indexer.config.GAS_PRICE, localPrice);
    });

    it('JSON-parses a GAS_SCHEDULE blob from the hub', async function () {
        indexer = makeIndexer();
        let schedule = { ISSUE: 200000, ISSUE_SUBTOKEN: 100000 };

        let hubStub = { enabled: true, _call: sinon.stub().resolves({
            BTC: { regtest: { 'xchain-indexer': { GAS_SCHEDULE: JSON.stringify(schedule) } } }
        })};
        indexer.hubClient = hubStub;

        await indexer._applyHubConfigOverlay();

        assert.deepStrictEqual(indexer.config.GAS_SCHEDULE, schedule);
    });

    it('re-points the VM gasSchedule at the updated GAS_SCHEDULE blob', async function () {
        indexer = makeIndexer();
        let schedule = { ISSUE: 222000, ISSUE_SUBTOKEN: 111000 };

        // Simulate the constructed VM that captured the startup-time schedule by reference.
        let startupSchedule = indexer.config.GAS_SCHEDULE;
        indexer.actions = { vm: { gasSchedule: startupSchedule } };

        let hubStub = { enabled: true, _call: sinon.stub().resolves({
            BTC: { regtest: { 'xchain-indexer': { GAS_SCHEDULE: JSON.stringify(schedule) } } }
        })};
        indexer.hubClient = hubStub;

        await indexer._applyHubConfigOverlay();

        // The VM must share the exact object the pre-VM charge sites read from config,
        // otherwise in-VM gas metering diverges from the base-fee charges.
        assert.deepStrictEqual(indexer.actions.vm.gasSchedule, schedule);
        assert.strictEqual(indexer.actions.vm.gasSchedule, indexer.config.GAS_SCHEDULE);
        assert.notStrictEqual(indexer.actions.vm.gasSchedule, startupSchedule);
    });

    it('skips overlay when hub client is disabled', async function () {
        indexer = makeIndexer();
        let localPrice = indexer.config.GAS_PRICE;

        let hubStub = { enabled: false, _call: sinon.stub().resolves({}) };
        indexer.hubClient = hubStub;

        await indexer._applyHubConfigOverlay();

        assert.strictEqual(indexer.config.GAS_PRICE, localPrice);
        assert.ok(!hubStub._call.called, '_call should not be invoked when disabled');
    });

    it('unwraps a { configs, seq } response and records the committed seq', async function () {
        indexer = makeIndexer();

        let hubStub = { enabled: true, _call: sinon.stub().resolves({
            configs: { BTC: { regtest: { 'xchain-indexer': { GAS_PRICE: '0.00077' } } } },
            seq: 5
        })};
        indexer.hubClient = hubStub;

        await indexer._applyHubConfigOverlay();

        assert.strictEqual(indexer.config.GAS_PRICE, '0.00077');
        assert.strictEqual(indexer.lastHubConfigSeq, 5);
    });

    it('poll re-applies the overlay only when the committed seq advances', async function () {
        indexer = makeIndexer();
        let clock = sinon.useFakeTimers();
        try {
            // Startup: seq 5, GAS_PRICE 0.00010
            let hubStub = { enabled: true, _call: sinon.stub() };
            hubStub._call.onCall(0).resolves({
                configs: { BTC: { regtest: { 'xchain-indexer': { GAS_PRICE: '0.00010' } } } }, seq: 5
            });
            indexer.hubClient = hubStub;
            await indexer._applyHubConfigOverlay();
            assert.strictEqual(indexer.config.GAS_PRICE, '0.00010');
            assert.strictEqual(indexer.lastHubConfigSeq, 5);

            process.env.HUB_CONFIG_POLL_INTERVAL_MS = '60000';
            indexer._startHubConfigPolling();

            // Tick 1: same seq (5) but different value — must NOT re-apply (stale guard).
            hubStub._call.onCall(1).resolves({
                configs: { BTC: { regtest: { 'xchain-indexer': { GAS_PRICE: '0.99999' } } } }, seq: 5
            });
            await clock.tickAsync(60000);
            assert.strictEqual(indexer.config.GAS_PRICE, '0.00010', 'unchanged seq must not re-apply');

            // Tick 2: seq advances to 6 — now the new value takes effect without a restart.
            hubStub._call.onCall(2).resolves({
                configs: { BTC: { regtest: { 'xchain-indexer': { GAS_PRICE: '0.00022' } } } }, seq: 6
            });
            await clock.tickAsync(60000);
            assert.strictEqual(indexer.config.GAS_PRICE, '0.00022', 'advanced seq must re-apply');
            assert.strictEqual(indexer.lastHubConfigSeq, 6);
        } finally {
            if(indexer._hubConfigPollTimer) clearInterval(indexer._hubConfigPollTimer);
            clock.restore();
            delete process.env.HUB_CONFIG_POLL_INTERVAL_MS;
        }
    });
});
