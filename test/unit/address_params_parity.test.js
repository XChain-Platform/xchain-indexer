/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * ADDRESS_PARAMS <-> canonical coins registry parity guard.
 *
 * utility.js keeps a hand-maintained ADDRESS_PARAMS table of base58 version
 * bytes + bech32 HRPs that isCryptoAddress() actually reads while validating
 * recipient addresses (SEND / DISPENSER / ORDER GET_ADDRESS), i.e. it is
 * consensus-relevant. The consensus pin (coins/consensus_pin.js) hashes the
 * bundled coins/*.js net objects, NOT this parallel table, so a divergence
 * between the two would stay invisible to verifyConsensusPin. This test pins
 * every ADDRESS_PARAMS entry to the pin-covered canonical net object so a
 * one-sided edit of either copy fails loudly here.
 *
 * ADDRESS_PARAMS is module-private (utility.js exports the Utility class), so
 * the literal is extracted from the source text by brace matching and
 * evaluated in isolation; it is a static object literal by construction.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const coins = require('../../src/coins');

function extractAddressParams(){
    const src   = fs.readFileSync(path.resolve(__dirname, '../../src/utility.js'), 'utf8');
    const decl  = src.indexOf('const ADDRESS_PARAMS');
    assert.notStrictEqual(decl, -1, 'utility.js no longer declares ADDRESS_PARAMS; update or retire this guard');
    const open  = src.indexOf('{', decl);
    let depth = 0, end = -1;
    for(let i = open; i < src.length; i++){
        if(src[i] === '{') depth++;
        else if(src[i] === '}'){ depth--; if(depth === 0){ end = i; break; } }
    }
    assert.notStrictEqual(end, -1, 'could not brace-match the ADDRESS_PARAMS literal');
    // Static literal (hex numbers / strings / null only); evaluate in isolation.
    return new Function('return (' + src.slice(open, end + 1) + ');')();
}

describe('ADDRESS_PARAMS parity with the consensus-pinned coins registry', function(){
    const PARAMS = extractAddressParams();

    it('covers exactly the allowed coins and networks', function(){
        assert.deepStrictEqual(Object.keys(PARAMS).sort(), [...coins.ALLOWED_COINS].sort(),
            'ADDRESS_PARAMS coin set drifted from coins.ALLOWED_COINS');
        for(const tick of coins.ALLOWED_COINS)
            assert.deepStrictEqual(Object.keys(PARAMS[tick]).sort(), [...coins.NETWORKS].sort(),
                'ADDRESS_PARAMS[' + tick + '] network set drifted from coins.NETWORKS');
    });

    for(const tick of ['BTC', 'LTC', 'DOGE']){
        for(const net of ['mainnet', 'testnet', 'regtest']){
            it(tick + '/' + net + ' base58 prefixes + HRP equal the canonical net object', function(){
                const canonical = coins.getCoinConfig(tick, net).net;
                const local     = PARAMS[tick][net];
                assert.strictEqual(local.p2pkh, canonical.pubKeyHash,
                    tick + '/' + net + ' p2pkh drifted from coins/' + tick + '.js pubKeyHash');
                assert.strictEqual(local.p2sh, canonical.scriptHash,
                    tick + '/' + net + ' p2sh drifted from coins/' + tick + '.js scriptHash');
                // DOGE has no segwit: the canonical net omits bech32 and the local hrp is null.
                assert.strictEqual(local.hrp, canonical.bech32 === undefined ? null : canonical.bech32,
                    tick + '/' + net + ' hrp drifted from coins/' + tick + '.js bech32');
            });
        }
    }
});
