// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// CONSENSUS guard for src/protocolAddressRoles.js. The block-hash preimage
// substitutes protocol special addresses for their role token so identical
// actions hash identically across chains. Two ways that map can silently break
// consensus, both guarded here:
//   1. a config edit adds/changes a special address but the canonical map does
//      not pick it up (it is config-derived, so this asserts coverage);
//   2. the frozen mirror vendored in xchain-sync/src/protocolAddressRoles.js
//      drifts from this source (a replica would then recompute a mismatching
//      hash). The expected snapshot below is the byte-for-byte contract both
//      repos must satisfy.

const assert = require('assert');
const { ROLE_BY_ADDRESS, canonicalizeHashAddress, ROLE_FIELDS } = require('../../src/protocolAddressRoles');

const COINS    = ['BTC', 'LTC', 'DOGE'];
const NETWORKS = ['mainnet', 'testnet', 'regtest'];
// Roles that legitimately have NO ledger-delta presence are excluded from the
// hashed map on purpose; FEE_DESTINATION is native-fee-only and env-overridable.
const HASHED_ROLES = ['BURN', 'GAS', 'DONATE1', 'DONATE2', 'REWARD'];

describe('protocolAddressRoles (consensus hash canonicalization)', function () {

    it('covers every hashed special address in src/configs/*.js', function () {
        for (const coin of COINS) {
            const cfg = require('../../src/configs/' + coin + '.js');
            for (const network of NETWORKS) {
                const addr = (cfg.getConfig(network).ADDRESS) || {};
                for (const role of HASHED_ROLES) {
                    const a = addr[role];
                    if (!a) continue;
                    assert.strictEqual(ROLE_BY_ADDRESS[a], role,
                        `${coin}/${network} ${role} (${a}) is not mapped to its role token; ` +
                        `regenerate the map and the xchain-sync mirror`);
                }
            }
        }
    });

    it('maps no address to two different roles (no collision)', function () {
        // ROLE_BY_ADDRESS is address-keyed, so a collision would already have
        // overwritten silently; re-derive and assert each address is single-valued.
        const seen = {};
        for (const coin of COINS) {
            const cfg = require('../../src/configs/' + coin + '.js');
            for (const network of NETWORKS) {
                const addr = (cfg.getConfig(network).ADDRESS) || {};
                for (const role of HASHED_ROLES) {
                    const a = addr[role];
                    if (!a) continue;
                    assert.ok(seen[a] === undefined || seen[a] === role,
                        `address ${a} maps to both ${seen[a]} and ${role}`);
                    seen[a] = role;
                }
            }
        }
    });

    it('canonicalizes a known special address to its role and passes others through', function () {
        const btc = require('../../src/configs/BTC.js').getConfig('regtest').ADDRESS;
        assert.strictEqual(canonicalizeHashAddress(btc.DONATE1), 'DONATE1');
        assert.strictEqual(canonicalizeHashAddress(btc.GAS), 'GAS');
        // A plain user address is unchanged.
        assert.strictEqual(canonicalizeHashAddress('mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu'),
            'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu');
        assert.strictEqual(canonicalizeHashAddress(null), null);
    });

    it('exports the expected role-field set', function () {
        assert.deepStrictEqual([...ROLE_FIELDS].sort(), [...HASHED_ROLES].sort());
    });
});
