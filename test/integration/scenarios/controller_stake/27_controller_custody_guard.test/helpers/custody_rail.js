'use strict';

const DENY_GUARD = "module.exports={ meta:{ name:'Deny Guard', description:'Reverts every gated transfer.', version:'1.0.0' }, guard:function(){ xchain.revert('policy denied'); } };";
const ALLOW_GUARD = "module.exports={ meta:{ name:'Allow Guard', description:'Permits every gated transfer.', version:'1.0.0' }, guard:function(){ return {}; } };";
const CUSTODY_GUARD_ENV = 'CONTROLLER_CUSTODY_GUARD_REGTEST_TIME';
const PROTOCOL_CHANGES_PATH = require.resolve('../../../../../../src/protocol_changes.js');
const CHANGES_5_PATH = require.resolve('../../../../../../src/protocol_changes/changes_5.js');

function custodyAddress(chain, contractIndex) {
    return 'C:' + chain + ':' + contractIndex;
}

function depositLine(contractIndex, tick, quantity) {
    return ['DEPOSIT', '0', contractIndex, tick, quantity].join('|');
}

function withdrawLine(contractIndex, tick, quantity) {
    return ['WITHDRAW', '0', contractIndex, tick, quantity].join('|');
}

function bindTokenLine(tick, controllerIndex, actionClass, memo) {
    return ['ISSUE', '6', tick, controllerIndex, actionClass, '0', '0', memo].join('|');
}

function bindAddressLine(controllerIndex, actionClass, memo) {
    return ['ADDRESS', '1', controllerIndex, actionClass, '0', '0', memo].join('|');
}

function dropProtocolChangeCache() {
    delete require.cache[PROTOCOL_CHANGES_PATH];
    delete require.cache[CHANGES_5_PATH];
}

function armCustodyGuardAt(time) {
    const prior = process.env[CUSTODY_GUARD_ENV];
    process.env[CUSTODY_GUARD_ENV] = String(time);
    dropProtocolChangeCache();
    return function restore() {
        if (prior === undefined) delete process.env[CUSTODY_GUARD_ENV];
        else process.env[CUSTODY_GUARD_ENV] = prior;
        dropProtocolChangeCache();
    };
}

module.exports = {
    DENY_GUARD,
    ALLOW_GUARD,
    custodyAddress,
    depositLine,
    withdrawLine,
    bindTokenLine,
    bindAddressLine,
    armCustodyGuardAt,
};
