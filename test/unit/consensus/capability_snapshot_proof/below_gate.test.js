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
const { verifyCapabilitySnapshotRow } = require(
    '../../../../src/db/database/stake_weights.js');

const CAPABILITIES = ['cross_chain', 'oracle_publish', 'price', 'attestation'];

function snapshotRow(capability = 'oracle_publish'){
    return {
        // Below the v0.25.0 BTC:testnet capability-proof arm (157053); mainnet stays unarmed.
        snapshot_block: 157052,
        capability,
        signing_pubkey: 'a'.repeat(64),
        source: 'src1',
        amount: '100',
    };
}

function proofRecorder(){
    const calls = [];
    return {
        calls,
        fetchProof: async (...args) => {
            calls.push(args);
            return null;
        },
    };
}

async function verify(subject, row, recorder){
    return verifyCapabilitySnapshotRow.call(subject, row, {
        fetchProof: recorder.fetchProof,
    });
}

describe('capability snapshot proof below-gate behavior @regression @tier1', function () {
    it('keeps LTC and DOGE mirror-resolved capabilities unknown on mainnet and testnet', async function () {
        const recorder = proofRecorder();

        for(const coin of ['LTC', 'DOGE']){
            for(const network of ['mainnet', 'testnet']){
                for(const capability of CAPABILITIES){
                    const subject = {
                        config: { COIN: coin, NETWORK: network },
                        isCapabilityConfigured: () => true,
                        getLatestBlockIndex: async () => Number.MAX_SAFE_INTEGER,
                    };
                    const actual = await verify(subject, snapshotRow(capability), recorder);

                    assert.strictEqual(actual.verdict, 'unknown',
                        `${coin} ${network} ${capability}`);
                    assert.match(actual.reason, /from the mirror/,
                        `${coin} ${network} ${capability}`);
                }
            }
        }

        assert.deepStrictEqual(recorder.calls, []);
    });

    it('keeps an unconfigured BTC capability unknown without fetching a proof', async function () {
        const recorder = proofRecorder();
        const subject = {
            config: { COIN: 'BTC', NETWORK: 'mainnet' },
            isCapabilityConfigured: () => false,
        };

        const actual = await verify(subject, snapshotRow(), recorder);

        assert.strictEqual(actual.verdict, 'unknown');
        assert.match(actual.reason, /not configured/);
        assert.deepStrictEqual(recorder.calls, []);
    });

    it('keeps a BTC row above the local tip unknown without fetching a proof', async function () {
        const recorder = proofRecorder();
        const subject = {
            config: { COIN: 'BTC', NETWORK: 'testnet' },
            isCapabilityConfigured: () => true,
            getLatestBlockIndex: async () => 5,
        };

        const actual = await verify(subject, snapshotRow(), recorder);

        assert.strictEqual(actual.verdict, 'unknown');
        assert.match(actual.reason, /has not reached/);
        assert.deepStrictEqual(recorder.calls, []);
    });
});
