/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const changes = require('../../../../src/consensus/gate_registry.js');
const startup = require('../../../../src/XChainIndexer/startup.js');

const PIN = 'CHECKPOINT_VALIDATORS_BTC_TESTNET';
const ENV_NAMES = [PIN, PIN + '_NEXT', PIN + '_FROM'];

function indexer(network = 'testnet', coin = 'DOGE'){
    return {
        config: { NETWORK: network, COIN: coin },
        util: { throwError(message){ throw new Error(message); } },
    };
}

function setPin(value){
    if(value === undefined) delete process.env[PIN];
    else process.env[PIN] = value;
    delete process.env[PIN + '_NEXT'];
    delete process.env[PIN + '_FROM'];
}

describe('capability snapshot proof startup pin wiring @regression @tier1', function () {
    let saved;

    beforeEach(function () {
        saved = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
    });

    afterEach(function () {
        sinon.restore();
        for(const name of ENV_NAMES){
            if(saved[name] === undefined) delete process.env[name];
            else process.env[name] = saved[name];
        }
    });

    it('refuses an armed mirror-backed testnet with no pin and names rotation variables', function () {
        sinon.stub(changes, 'get').returns({ testnet: 50 });
        setPin(undefined);

        assert.throws(() => startup.assertCapabilitySnapshotPin.call(indexer()), error => {
            assert.match(error.message, new RegExp(PIN));
            assert.match(error.message, new RegExp(PIN + '_NEXT'));
            assert.match(error.message, new RegExp(PIN + '_FROM'));
            return true;
        });
    });

    it('refuses an armed mirror-backed testnet with an invalid pin', function () {
        sinon.stub(changes, 'get').returns({ testnet: 50 });
        setPin('not json');

        assert.throws(() => startup.assertCapabilitySnapshotPin.call(indexer()),
            /not valid JSON/);
    });

    it('does not refuse an unarmed chain, BTC, or regtest', function () {
        const get = sinon.stub(changes, 'get');
        setPin(undefined);

        get.returns({ testnet: changes.UNARMED });
        assert.doesNotThrow(() => startup.assertCapabilitySnapshotPin.call(indexer()));

        get.returns({ testnet: 0 });
        assert.doesNotThrow(() => startup.assertCapabilitySnapshotPin.call(indexer('testnet', 'BTC')));

        get.returns({ regtest: 0 });
        assert.doesNotThrow(() => startup.assertCapabilitySnapshotPin.call(indexer('regtest')));
    });
});
