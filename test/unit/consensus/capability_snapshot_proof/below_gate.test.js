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
const ProtocolChanges = require('../../../../src/protocol_changes.js');

const CAPABILITIES = ['cross_chain', 'oracle_publish', 'price', 'attestation'];
// Testnet arms the gate at a past BTC height, so a testnet row is below it only one
// block under that height; mainnet is unarmed and any height is below it.
const TESTNET_ARM = ProtocolChanges.get(
    'capability_snapshot_proof_activation.CAPABILITY_SNAPSHOT_PROOF_ACTIVATION')['BTC:testnet'];
const BELOW_GATE = { mainnet: 900000, testnet: TESTNET_ARM - 1 };

function snapshotRow(capability = 'oracle_publish', snapshotBlock = 900000){
    return {
        snapshot_block: snapshotBlock,
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
    it('refuses non-canonical heights before checking the proof gate', async function () {
        const badHeights = ['2e5', '161789.5', ' 200000', '200000abc', '+.2e6',
                            '0x30d40', -1, 1.5, null, '9007199254740993'];
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            for(const network of ['testnet', 'regtest']){
                const recorder = proofRecorder();
                const subject = {
                    config: { COIN: coin, NETWORK: network },
                    isCapabilityConfigured: () => true,
                };
                for(const height of badHeights){
                    const actual = await verify(subject, snapshotRow('cross_chain', height), recorder);
                    assert.strictEqual(actual.verdict, 'refused', `${coin} ${network} ${height}`);
                    assert.match(actual.reason, /non-canonical snapshot_block/);
                }
                assert.deepStrictEqual(recorder.calls, []);
            }
        }
    });

    it('accepts canonical number and digit-string heights at the proof gate', async function () {
        for(const height of [TESTNET_ARM, String(TESTNET_ARM)]){
            const recorder = proofRecorder();
            const subject = {
                config: { COIN: 'LTC', NETWORK: 'testnet' },
                isCapabilityConfigured: () => true,
            };
            await verify(subject, snapshotRow('cross_chain', height), recorder);
            assert.strictEqual(recorder.calls.length, 1, String(height));
            assert.strictEqual(recorder.calls[0][0], TESTNET_ARM);
        }
    });

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
                    const actual = await verify(subject,
                        snapshotRow(capability, BELOW_GATE[network]), recorder);

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
