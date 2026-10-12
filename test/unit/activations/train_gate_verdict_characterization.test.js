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
 * Whole-verdict characterization of evaluateTrainActivation.
 *
 * Every case compares all eight verdict fields, each reason as the full string the
 * function returns, so a refactor of the gate or a byte copy of it is checked
 * against output captured before the change. The activation map is passed
 * explicitly in every call, so the default map is never read.
 *********************************************************************/

'use strict';

const assert = require('assert');

const ta = require('../../../src/consensus/gates/train_gate.js');

const FLOOR   = { '1.0.0': { mainnet: 0, testnet: 0, regtest: 0 } };
const TWO_ARM = { '1.0.0': { mainnet: 0, testnet: 0, regtest: 0 },
                  '2.0.0': { mainnet: 970000, testnet: 150000, regtest: 0 } };

function manifest(block){ return block === undefined ? {} : { trainActivation: block }; }
function armed(version, heights){
    return { ruleSetVersion: version, classification: 'major', heights: heights,
             computedFromBtcTip: { mainnet: 0, testnet: 0, regtest: 0 } };
}

const TAIL = 'platform version 2.0.0 carries it; recover with the node update command, ' +
             'which installs the pinned component set from the signed manifest';

function verdict(fields){
    return Object.assign({
        status: 'clear', activeRuleSet: '1.0.0', requiredRuleSet: null, requiredAtHeight: null,
        network: 'mainnet', height: 969999, classification: null, reason: null
    }, fields);
}

describe('train gate verdict characterization: requirement read @regression', function () {

    it('gives clear when nothing is required', function () {
        const got = ta.evaluateTrainActivation({
            height: 969999, network: 'mainnet', manifest: manifest(undefined), activation: FLOOR
        });
        assert.deepStrictEqual(got, verdict({}));
    });

    it('gives halt with no classification for a malformed block', function () {
        const got = ta.evaluateTrainActivation({
            height: 969999, network: 'mainnet', manifest: manifest({ ruleSetVersion: 'two' }), activation: FLOOR
        });
        assert.deepStrictEqual(got, verdict({
            status: 'halt',
            reason: 'train_activation: the release manifest carries a trainActivation block this build ' +
                    'cannot read (trainActivation.ruleSetVersion is not a bare X.Y.Z ("two")), so the ' +
                    'required rule set cannot be determined; refusing to advance'
        }));
    });

    it('gives clear and carries the classification for an implemented rule set', function () {
        const got = ta.evaluateTrainActivation({
            height: 969999, network: 'mainnet', activation: TWO_ARM,
            manifest: manifest(armed('2.0.0', { mainnet: 970000 }))
        });
        assert.deepStrictEqual(got, verdict({ classification: 'major' }));
    });
});

describe('train gate verdict characterization: halts @regression', function () {

    it('gives halt when the block names no activation height for the network', function () {
        const got = ta.evaluateTrainActivation({
            height: 969999, network: 'testnet', activation: FLOOR,
            manifest: manifest(armed('2.0.0', { mainnet: 970000 }))
        });
        assert.deepStrictEqual(got, verdict({
            status: 'halt', network: 'testnet', requiredRuleSet: '2.0.0', classification: 'major',
            reason: 'train_activation: the release manifest requires rule set 2.0.0, which this build does ' +
                    'not implement, and names no activation height for network "testnet", so the boundary ' +
                    'cannot be proven to be ahead. ' + TAIL
        }));
    });

    it('gives halt for a null height, naming no BTC height', function () {
        const got = ta.evaluateTrainActivation({
            height: null, network: 'mainnet', activation: FLOOR,
            manifest: manifest(armed('2.0.0', { mainnet: 970000 }))
        });
        assert.deepStrictEqual(got, verdict({
            status: 'halt', activeRuleSet: null, height: null, requiredRuleSet: '2.0.0',
            requiredAtHeight: 970000, classification: 'major',
            reason: 'train_activation: the release manifest requires rule set 2.0.0 at BTC height 970000 ' +
                    'on mainnet, which this build does not implement, and this service has ' +
                    'no BTC height to compare against, so the boundary cannot be proven to be ahead. ' + TAIL
        }));
    });

    it('gives halt at the boundary and above it', function () {
        for (const h of [970000, 970001]) {
            const got = ta.evaluateTrainActivation({
                height: h, network: 'mainnet', activation: FLOOR,
                manifest: manifest(armed('2.0.0', { mainnet: 970000 }))
            });
            assert.deepStrictEqual(got, verdict({
                status: 'halt', height: h, requiredRuleSet: '2.0.0', requiredAtHeight: 970000,
                classification: 'major',
                reason: 'train_activation: block at BTC height ' + h + ' is at or above the 2.0.0 ' +
                        'activation height 970000 on mainnet, and this build does not implement rule set ' +
                        '2.0.0. Applying it under the old rules would fork. ' + TAIL
            }));
        }
    });
});

describe('train gate verdict characterization: pending @regression', function () {

    it('gives pending three blocks below the boundary', function () {
        const got = ta.evaluateTrainActivation({
            height: 969997, network: 'mainnet', activation: FLOOR,
            manifest: manifest(armed('2.0.0', { mainnet: 970000 }))
        });
        assert.deepStrictEqual(got, verdict({
            status: 'pending', height: 969997, requiredRuleSet: '2.0.0', requiredAtHeight: 970000,
            classification: 'major',
            reason: 'train_activation: the release manifest requires rule set 2.0.0 from BTC height ' +
                    '970000 on mainnet, which this build does not implement. This node will HALT at that ' +
                    'height, in 3 block(s). ' + TAIL
        }));
    });

    it('returns one pending verdict whether required is a block, a raw manifest, or a manifest', function () {
        const block = armed('2.0.0', { mainnet: 970000 });
        const base = { height: 969997, network: 'mainnet', activation: FLOOR };
        const viaBlock    = ta.evaluateTrainActivation(Object.assign({ required: block }, base));
        const viaRaw      = ta.evaluateTrainActivation(Object.assign({ required: { trainActivation: block } }, base));
        const viaManifest = ta.evaluateTrainActivation(Object.assign({ manifest: manifest(block) }, base));
        assert.strictEqual(viaBlock.status, 'pending');
        assert.deepStrictEqual(viaRaw, viaBlock);
        assert.deepStrictEqual(viaManifest, viaBlock);
    });
});
