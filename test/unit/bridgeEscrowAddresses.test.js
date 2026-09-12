// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// CONSENSUS guard for the XBRIDGE escrow constants (base spec section 5, token
// spec R3). The escrow is an ordinary balance at ADDRESS.BRIDGE_<COIN>, so a
// malformed literal is not a config typo: it is an address the chain can never
// pay out of and a supply on the destination with nothing behind it. Three ways
// that can go wrong, all guarded here:
//   1. a literal that is not a valid address on ITS OWN chain and network (wrong
//      version byte, bad checksum, copied from a sibling chain),
//   2. a literal that collides with another protocol role, which would make the
//      escrow spendable through that role's path or corrupt the hash preimage,
//   3. a missing XBRIDGE_BASE gas entry, which makes every lock and burn
//      unpriceable on the chain that lacks it.
// Keylessness is the fourth property and it is NOT tested here: bridgeEscrowKeylessness
// .test.js owns it. The readable text lives in the base58 STRING, never in the decoded
// bytes: measured 2026-09-12, '17BridgeLtcXChainXXXXXXXXXXa5uRRy' base58check-decodes to
// version 0x00 plus hash160 012b8f14947cc310298e6b49b68ea24e2bbdcbc0, which is not ASCII,
// and BTC mainnet BURN decodes the same way to 05b63ec8f5f45c95801e38f4fd8305e57b75c151.
// What makes either unspendable is that no key ever produced that hash160, so a
// payout needs a public key K with RIPEMD160(SHA256(K)) equal to those exact 20 bytes.
// It is the same construction BURN and the DONATE addresses already ship.

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../src/utility.js');
const coins   = require('../../src/coins');
const { ROLE_BY_ADDRESS } = require('../../src/protocolAddressRoles.js');

const COINS    = ['BTC', 'LTC', 'DOGE'];
const NETWORKS = ['mainnet', 'testnet', 'regtest'];
// Every role a coin bundle carries that is NOT a bridge escrow. A bridge address
// must differ from all of them on its own chain.
const OTHER_ROLES = ['BURN', 'GAS', 'DONATE1', 'DONATE2', 'FEE_DESTINATION', 'REWARD', 'EXPLORER'];

describe('XBRIDGE escrow constants (consensus)', function () {

    const util = new Utility();

    it('carries BRIDGE_<COIN> for every other coin, and none for itself, on every network', function () {
        for (const coin of COINS) {
            const cfg = require('../../src/configs/' + coin + '.js');
            for (const network of NETWORKS) {
                const addr = cfg.getConfig(network).ADDRESS || {};
                for (const other of COINS) {
                    const role = 'BRIDGE_' + other;
                    if (other === coin) {
                        // A chain never escrows to itself: v0/v3 refuse DEST_COIN
                        // equal to the source chain, so the role would be dead weight
                        // in the hash preimage.
                        assert.strictEqual(addr[role], undefined,
                            `${coin}/${network} must not carry ${role}`);
                        continue;
                    }
                    assert.ok(addr[role], `${coin}/${network} is missing ${role}`);
                }
            }
        }
    });

    it('every escrow literal is a valid address on its own chain and network', function () {
        for (const coin of COINS) {
            const cfg = require('../../src/configs/' + coin + '.js');
            for (const network of NETWORKS) {
                const addr = cfg.getConfig(network).ADDRESS || {};
                for (const other of COINS) {
                    if (other === coin) continue;
                    const a = addr['BRIDGE_' + other];
                    // The same call the v0 handler makes on DEST_ADDRESS: full
                    // base58check, version byte included, on this coin and network.
                    assert.strictEqual(util.isCryptoAddress(a, coin, network), true,
                        `${coin}/${network} BRIDGE_${other} (${a}) is not a valid ${coin} ${network} address`);
                }
            }
        }
    });

    it('no escrow literal collides with another protocol role on the same chain', function () {
        for (const coin of COINS) {
            const cfg = require('../../src/configs/' + coin + '.js');
            const raw = require('../../src/coins/' + coin + '.js');
            for (const network of NETWORKS) {
                const addr    = cfg.getConfig(network).ADDRESS || {};
                // EXPLORER is stripped by the indexer adapter, so read the bundle
                // directly to cover it too.
                const bundle  = raw.networks[network].addresses;
                for (const other of COINS) {
                    if (other === coin) continue;
                    const a = addr['BRIDGE_' + other];
                    for (const role of OTHER_ROLES) {
                        if (!bundle[role] || bundle[role] === 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX') continue;
                        assert.notStrictEqual(a, bundle[role],
                            `${coin}/${network} BRIDGE_${other} collides with ${role}`);
                    }
                }
                // And the two escrows on one chain are never the same address.
                const escrows = COINS.filter(c => c !== coin).map(c => addr['BRIDGE_' + c]);
                assert.strictEqual(new Set(escrows).size, escrows.length,
                    `${coin}/${network} reuses one address for two bridge destinations`);
            }
        }
    });

    it('maps every escrow literal to its role token in the hash preimage', function () {
        for (const coin of COINS) {
            const cfg = require('../../src/configs/' + coin + '.js');
            for (const network of NETWORKS) {
                const addr = cfg.getConfig(network).ADDRESS || {};
                for (const other of COINS) {
                    if (other === coin) continue;
                    const role = 'BRIDGE_' + other;
                    assert.strictEqual(ROLE_BY_ADDRESS[addr[role]], role,
                        `${coin}/${network} ${role} is not canonicalized to its role token`);
                }
            }
        }
    });

    it('folds the escrow addresses into the pinned consensus subset', function () {
        // The addresses decide where value is held, so they must be inside
        // CONSENSUS_CONFIG_PIN's preimage, not classified display-only.
        for (const coin of COINS) {
            for (const network of NETWORKS) {
                const subset = coins.consensusSubset(coin, network);
                for (const other of COINS) {
                    if (other === coin) continue;
                    assert.ok(subset.addresses['BRIDGE_' + other],
                        `${coin}/${network} BRIDGE_${other} is missing from the consensus subset`);
                }
            }
        }
    });

    it('prices XBRIDGE_BASE identically on every chain', function () {
        for (const coin of COINS) {
            for (const network of NETWORKS) {
                const cfg = require('../../src/configs/' + coin + '.js').getConfig(network);
                // 5,000 gas = 0.05 XCHAIN at the initial GAS_PRICE (base spec D3),
                // sized at SWEEP_BASE so the smallest bridge action still buys an
                // above-dust native-coin fee output on LTC and DOGE.
                assert.strictEqual(cfg.GAS_SCHEDULE.XBRIDGE_BASE, 5000,
                    `${coin}/${network} XBRIDGE_BASE is not 5000`);
            }
        }
    });
});
