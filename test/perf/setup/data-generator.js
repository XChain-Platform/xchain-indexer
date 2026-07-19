'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const DecoderSeeder = require('../../integration/setup/decoder-seeder');

// 34-char GAS address for BTC regtest
const GAS_ADDR = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const TICK_GAS = 'XCHAIN';

// 10 test addresses, valid regtest P2PKH (isCryptoAddress verifies base58check)
const PERF_ADDRS = [
    'mq69zWDZmUo27UV2kBEizTBmKP8qoBRDH5', 'muFL6KMd9eEkxcuNHTKbSmkZj6TqBfQMdm',
    'n13R1eZGMyjzfG1txVRH1H2RFkdathxhWe', 'n2t9NyzYAREoWkoqZxJYpEjbHq4jzNHntf',
    'n3mnWv4YBxt3qCRP8Pn7gnp6EqM3Aj4btW', 'mrzdeFj6LJULgDKnb72SDZ8Q6gHE6RS1YF',
    'mxXExuJZdna719k514xnbhq1aDvSPRhFvk', 'mnzndbPioooMVtSRd6KvyG2cMr1rW6m6J1',
    'mjeW11pd6TSt14NZt7dWJRJJy8qNRxfEJc', 'my1poBUbZNyYEoowhPZDManQvwj3rYcCoa',
];

class DataGenerator extends DecoderSeeder {

    constructor(queryFn) {
        super(queryFn);
        this.state = {
            tokens: {},       // tick → { issuer, supply, maxMint, decimals }
            balances: {},     // addr → { tick → amount }
            addresses: [...PERF_ADDRS],
            gasAddr: GAS_ADDR,
            nextTick: 0,
        };
        // Use high offset to avoid collision with parent's txCounter
        this.txCounter = 1000000;
    }

    /**
     * Seed XCHAIN gas token + two test tokens + fund all addresses.
     * Returns the next available block number.
     */
    async bootstrap(startBlock, baseTime) {
        let block = startBlock;
        const t = baseTime;
        const addrs = this.state.addresses;

        // Block 1: Issue XCHAIN from GAS address
        await this.seedBlock(block++, t, [
            { source: GAS_ADDR, data: `ISSUE|0|${TICK_GAS}|999999999|999999999|0` }
        ]);

        // Block 2: Mint XCHAIN to GAS address
        await this.seedBlock(block++, t + 600, [
            { source: GAS_ADDR, data: `MINT|0|${TICK_GAS}|999999999` }
        ]);

        // Block 3: Send XCHAIN to all test addresses (100000 each)
        const gasSends = addrs.map(addr => ({
            source: GAS_ADDR,
            data: `SEND|0|${TICK_GAS}|100000|${addr}|`
        }));
        await this.seedBlock(block++, t + 1200, gasSends);

        // Block 4: Issue TOKEN_A
        await this.seedBlock(block++, t + 1800, [
            { source: addrs[0], data: 'ISSUE|0|TOKENA|100000000|1000000|0' }
        ]);

        // Block 5: Issue TOKEN_B
        await this.seedBlock(block++, t + 2400, [
            { source: addrs[1], data: 'ISSUE|0|TOKENB|100000000|1000000|0' }
        ]);

        // Block 6: Mint TOKEN_A to addrs[0] and TOKEN_B to addrs[1]
        await this.seedBlock(block++, t + 3000, [
            { source: addrs[0], data: 'MINT|0|TOKENA|500000' },
            { source: addrs[1], data: 'MINT|0|TOKENB|500000' }
        ]);

        // Block 7: Distribute tokens to other addresses for diverse testing
        const distTxs = [];
        for (let i = 2; i < addrs.length; i++) {
            distTxs.push({ source: addrs[0], data: `SEND|0|TOKENA|10000|${addrs[i]}|` });
            distTxs.push({ source: addrs[1], data: `SEND|0|TOKENB|10000|${addrs[i]}|` });
        }
        await this.seedBlock(block++, t + 3600, distTxs);

        // Track state
        this.state.tokens['TOKENA'] = { issuer: addrs[0], supply: 500000, maxMint: 1000000, decimals: 0 };
        this.state.tokens['TOKENB'] = { issuer: addrs[1], supply: 500000, maxMint: 1000000, decimals: 0 };
        for (const addr of addrs) {
            this.state.balances[addr] = this.state.balances[addr] || {};
            this.state.balances[addr][TICK_GAS] = 100000;
        }
        this.state.balances[addrs[0]]['TOKENA'] = 500000 - (10000 * (addrs.length - 2));
        this.state.balances[addrs[1]]['TOKENB'] = 500000 - (10000 * (addrs.length - 2));
        for (let i = 2; i < addrs.length; i++) {
            this.state.balances[addrs[i]]['TOKENA'] = 10000;
            this.state.balances[addrs[i]]['TOKENB'] = 10000;
        }

        return block;
    }

    /**
     * Generate and seed a batch of blocks with a given action profile.
     *
     * @param {number} count       - Number of blocks to generate
     * @param {number} txsPerBlock - Target transactions per block
     * @param {string} profile     - Action profile name
     * @param {number} startBlock  - First block number
     * @param {number} baseTime    - Unix timestamp for first block
     * @returns {{ firstBlock, lastBlock, blocksSeeded }}
     */
    async generateBlocks(count, txsPerBlock, profile, startBlock, baseTime) {
        for (let i = 0; i < count; i++) {
            const blockIdx = startBlock + i;
            const blockTime = baseTime + (i * 600);
            const txs = this._buildTxsForProfile(profile, txsPerBlock, blockIdx, blockTime);
            await this.seedBlock(blockIdx, blockTime, txs);
        }
        return {
            firstBlock: startBlock,
            lastBlock: startBlock + count - 1,
            blocksSeeded: count
        };
    }

    _buildTxsForProfile(profile, txsPerBlock, blockIdx, blockTime) {
        if (txsPerBlock === 0) return [];
        switch (profile) {
            case 'send-only':    return this._profileSendOnly(txsPerBlock, blockIdx);
            case 'normal':       return this._profileNormal(txsPerBlock, blockIdx);
            case 'token-launch': return this._profileTokenLaunch(txsPerBlock, blockIdx);
            case 'heavy-dex':    return this._profileHeavyDex(txsPerBlock, blockIdx, blockTime);
            case 'standing-orders': return this._profileStandingOrders(txsPerBlock, blockIdx, blockTime);
            case 'mixed-heavy':  return this._profileMixedHeavy(txsPerBlock, blockIdx, blockTime);
            default:             return this._profileSendOnly(txsPerBlock, blockIdx);
        }
    }

    // --- Profiles ---

    _profileSendOnly(count, blockIdx) {
        const txs = [];
        const addrs = this.state.addresses;
        for (let i = 0; i < count; i++) {
            const from = addrs[i % addrs.length];
            const to = addrs[(i + 1) % addrs.length];
            txs.push({ source: from, data: `SEND|0|TOKENA|1|${to}|` });
        }
        return txs;
    }

    _profileNormal(count, blockIdx) {
        const txs = [];
        const addrs = this.state.addresses;
        for (let i = 0; i < count; i++) {
            const r = i / count; // deterministic distribution
            if (r < 0.6) {
                // SEND
                const from = addrs[i % addrs.length];
                const to = addrs[(i + 1) % addrs.length];
                const tick = (i % 2 === 0) ? 'TOKENA' : 'TOKENB';
                txs.push({ source: from, data: `SEND|0|${tick}|1|${to}|` });
            } else if (r < 0.8) {
                // MINT
                const tick = (i % 2 === 0) ? 'TOKENA' : 'TOKENB';
                const minter = (tick === 'TOKENA') ? addrs[0] : addrs[1];
                txs.push({ source: minter, data: `MINT|0|${tick}|10` });
            } else if (r < 0.9) {
                // ISSUE a new token
                const tick = this._nextTick(blockIdx, i);
                txs.push({ source: addrs[i % addrs.length], data: `ISSUE|0|${tick}|100000|1000|0` });
            } else {
                // DESTROY
                const from = addrs[i % addrs.length];
                txs.push({ source: from, data: 'DESTROY|0|TOKENA|1|' });
            }
        }
        return txs;
    }

    _profileTokenLaunch(count, blockIdx) {
        const txs = [];
        const addrs = this.state.addresses;
        // Half ISSUE, half MINT of those same tokens
        const issueCount = Math.ceil(count / 2);
        const ticks = [];
        for (let i = 0; i < issueCount; i++) {
            const tick = this._nextTick(blockIdx, i);
            ticks.push(tick);
            txs.push({ source: addrs[i % addrs.length], data: `ISSUE|0|${tick}|100000|1000|0` });
        }
        for (let i = 0; i < count - issueCount; i++) {
            const tick = ticks[i % ticks.length];
            const addr = addrs[i % addrs.length];
            txs.push({ source: addr, data: `MINT|0|${tick}|100` });
        }
        return txs;
    }

    _profileHeavyDex(count, blockIdx, blockTime) {
        const txs = [];
        const addrs = this.state.addresses;
        const expiry = blockTime + 90 * 86400; // 90 days, within fee-free window
        for (let i = 0; i < count; i++) {
            const from = addrs[i % addrs.length];
            const giveAmount = 1 + (i % 10);
            const getAmount = 1 + ((i + 3) % 10);
            // ORDER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|EXPIRATION
            txs.push({
                source: from,
                data: `ORDER|0|BTC|TOKENA|${giveAmount}|BTC|TOKENB|${getAmount}||${expiry}`
            });
        }
        return txs;
    }

    /**
     * Valid, always-open DEX orders that accumulate a growth-unbounded standing set.
     *
     * Every order is the SAME direction (give 1 TOKENA, get 1 TOKENB) so no two ever
     * cross-match, and the expiration sits inside the fee-free window but far past the
     * scenario's block-time span, so none ever expires during the run. The net effect:
     * the `orders`/`order_statuses` "open" set grows by `count` every block, which is
     * exactly what the per-block expiry sweep (db.getExpiredItems) must re-scan on
     * every block. This is what the grown-database regression scenario (07) leans on.
     *
     * NOTE: uses the current ORDER format 0, which carries GIVE_OWNERSHIP/GET_OWNERSHIP
     * fields. The older `heavy-dex`/`mixed-heavy` profiles omit those, so their orders
     * currently parse as invalid (GET_COIN lands on the wrong field) and never reach the
     * order book. Kept separate here so 07 is not built on that latent gap.
     */
    _profileStandingOrders(count, blockIdx, blockTime) {
        const txs = [];
        const addrs = this.state.addresses;
        // Sources that actually hold TOKENA after bootstrap: addrs[0] (bulk) plus
        // addrs[2..]. addrs[1] holds only TOKENB, so it cannot escrow a TOKENA give.
        const givers = [addrs[0], ...addrs.slice(2)];
        // 80 days: inside the 90-day fee-free expiration window (gasCost 0) yet far
        // beyond the run's block-time span, so every order stays open for the whole test.
        const expiry = blockTime + 80 * 86400;
        for (let i = 0; i < count; i++) {
            const from = givers[i % givers.length];
            // FORMAT 0: VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|
            //           GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION
            txs.push({
                source: from,
                data: `ORDER|0|BTC|TOKENA|1|0|BTC|TOKENB|1|0||${expiry}`
            });
        }
        return txs;
    }

    _profileMixedHeavy(count, blockIdx, blockTime) {
        const txs = [];
        const addrs = this.state.addresses;
        const expiry = blockTime + 90 * 86400;
        for (let i = 0; i < count; i++) {
            const r = i / count;
            const from = addrs[i % addrs.length];
            const to = addrs[(i + 1) % addrs.length];
            if (r < 0.25) {
                // SEND
                txs.push({ source: from, data: `SEND|0|TOKENA|1|${to}|` });
            } else if (r < 0.45) {
                // MINT
                const tick = (i % 2 === 0) ? 'TOKENA' : 'TOKENB';
                const minter = (tick === 'TOKENA') ? addrs[0] : addrs[1];
                txs.push({ source: minter, data: `MINT|0|${tick}|10` });
            } else if (r < 0.60) {
                // ISSUE
                const tick = this._nextTick(blockIdx, i);
                txs.push({ source: from, data: `ISSUE|0|${tick}|100000|1000|0` });
            } else if (r < 0.70) {
                // ORDER
                txs.push({
                    source: from,
                    data: `ORDER|0|BTC|TOKENA|${1 + (i % 5)}|BTC|TOKENB|${1 + (i % 5)}||${expiry}`
                });
            } else if (r < 0.80) {
                // BROADCAST
                txs.push({ source: from, data: `BROADCAST|0|Perf test message ${blockIdx}-${i}|` });
            } else if (r < 0.90) {
                // BATCH with two SENDs
                txs.push({
                    source: from,
                    data: `BATCH|0|SEND|0|TOKENA|1|${to}|;SEND|0|TOKENB|1|${to}|`
                });
            } else {
                // DESTROY
                txs.push({ source: from, data: 'DESTROY|0|TOKENA|1|' });
            }
        }
        return txs;
    }

    // --- Helpers ---

    _nextTick(blockIdx, txIdx) {
        this.state.nextTick++;
        return 'P' + String(this.state.nextTick).padStart(7, '0');
    }

    _randomAddr() {
        const addrs = this.state.addresses;
        return addrs[Math.floor(Math.random() * addrs.length)];
    }
}

module.exports = DataGenerator;
