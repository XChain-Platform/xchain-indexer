'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const FIXTURE = path.join(__dirname, '..', '..', '..', 'fixtures', 'price_v1_length_measurement.json');
const SCRIPT  = path.join(__dirname, '..', '..', '..', '..', 'bin', 'measure-price-v1-lengths.js');
const COINS   = ['BTC', 'LTC', 'DOGE', 'TBTC', 'TLTC', 'TDOGE'];
const COUNTS  = ['v1_rows', 'valid_v1_rows', 'longest_valid_value', 'longest_valid_fee',
                 'longest_canonical_value', 'longest_canonical_fee', 'leading_zero_rows'];

describe('PRICE v1 length measurement fixture', function () {
    const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

    it('carries base and an ISO read_at instant', function () {
        assert.match(fx.base, /^https?:\/\//);
        assert.match(fx.read_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.strictEqual(new Date(fx.read_at).toISOString(), fx.read_at);
    });

    it('has exactly the six chains', function () {
        assert.deepStrictEqual(Object.keys(fx.chains).sort(), [...COINS].sort());
    });

    it('holds every count as a non-negative integer', function () {
        for (const coin of COINS) {
            assert.deepStrictEqual(Object.keys(fx.chains[coin]).sort(), [...COUNTS].sort(), coin);
            for (const k of COUNTS) {
                const v = fx.chains[coin][k];
                assert.ok(Number.isInteger(v) && v >= 0, `${coin}.${k}`);
            }
        }
    });

    it('keeps valid rows within v1 rows and canonical lengths within valid lengths', function () {
        for (const coin of COINS) {
            const c = fx.chains[coin];
            assert.ok(c.valid_v1_rows <= c.v1_rows, coin);
            assert.ok(c.leading_zero_rows <= c.valid_v1_rows, coin);
            assert.ok(c.longest_canonical_value <= c.longest_valid_value, coin);
            assert.ok(c.longest_canonical_fee <= c.longest_valid_fee, coin);
        }
    });

    it('reads no process.env and defaults --base to the public explorer', function () {
        const src = fs.readFileSync(SCRIPT, 'utf8');
        assert.doesNotMatch(src, /process\.env/);
        assert.ok(src.includes("'https://explorer.xchain.io'"));
    });
});
