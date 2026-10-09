'use strict';

const assert = require('assert');
const {
    DENY_GUARD,
    ALLOW_GUARD,
    custodyAddress,
    depositLine,
    withdrawLine,
    bindTokenLine,
    bindAddressLine,
    armCustodyGuardAt,
} = require('./helpers/custody_rail.js');

const CUSTODY_GUARD_ENV = 'CONTROLLER_CUSTODY_GUARD_REGTEST_TIME';
const CHANGES_5_PATH = '../../../../../src/protocol_changes/changes_5.js';
const EXPECTED_DENY = "module.exports={ meta:{ name:'Deny Guard', description:'Reverts every gated transfer.', version:'1.0.0' }, guard:function(){ xchain.revert('policy denied'); } };";
const EXPECTED_ALLOW = "module.exports={ meta:{ name:'Allow Guard', description:'Permits every gated transfer.', version:'1.0.0' }, guard:function(){ return {}; } };";

function restoreOriginalEnv(original) {
    if (original === undefined) delete process.env[CUSTODY_GUARD_ENV];
    else process.env[CUSTODY_GUARD_ENV] = original;
}

function custodyGuardRegtestTime() {
    const rows = require(CHANGES_5_PATH);
    // Read by name because new protocol-change rows are inserted at the top.
    const row = rows.find(r => r[0] === 'CONTROLLER_CUSTODY_GUARD');
    assert(row, 'CONTROLLER_CUSTODY_GUARD protocol-change row not found');
    return row[4]();
}

describe('custody rail helpers', function () {
    it('pins guard source and wire-line builders', function () {
        assert.strictEqual(DENY_GUARD, EXPECTED_DENY);
        assert.strictEqual(ALLOW_GUARD, EXPECTED_ALLOW);
        assert.strictEqual(custodyAddress('BTC', 7), 'C:BTC:7');
        assert.strictEqual(depositLine(7, 'CTRL', 25), 'DEPOSIT|0|7|CTRL|25');
        assert.strictEqual(withdrawLine(7, 'CTRL', 25), 'WITHDRAW|0|7|CTRL|25');
        assert.strictEqual(bindTokenLine('CTRL', 7, 'deposit', 'bind-token'),
            'ISSUE|6|CTRL|7|deposit|0|0|bind-token');
        assert.strictEqual(bindAddressLine(7, 'withdraw', 'bind-address'),
            'ADDRESS|1|7|withdraw|0|0|bind-address');
    });

    it('arms a fresh protocol-change row and restores an unset variable', function () {
        const original = process.env[CUSTODY_GUARD_ENV];
        delete process.env[CUSTODY_GUARD_ENV];
        assert.strictEqual(custodyGuardRegtestTime(), 0);
        const restore = armCustodyGuardAt(1700000500);
        try {
            assert.strictEqual(custodyGuardRegtestTime(), 1700000500);
            restore();
            assert.strictEqual(process.env[CUSTODY_GUARD_ENV], undefined);
            assert.strictEqual(custodyGuardRegtestTime(), 0);
        } finally {
            restoreOriginalEnv(original);
        }
    });

    it('arms a fresh protocol-change row and restores a preset variable', function () {
        const original = process.env[CUSTODY_GUARD_ENV];
        process.env[CUSTODY_GUARD_ENV] = '5';
        assert.strictEqual(custodyGuardRegtestTime(), 5);
        const restore = armCustodyGuardAt(1700000500);
        try {
            assert.strictEqual(custodyGuardRegtestTime(), 1700000500);
            restore();
            assert.strictEqual(process.env[CUSTODY_GUARD_ENV], '5');
            assert.strictEqual(custodyGuardRegtestTime(), 5);
        } finally {
            restoreOriginalEnv(original);
        }
    });
});
