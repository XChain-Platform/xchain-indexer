/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const { deriveLateness, recordLateDerive } =
    require('../../../../src/consensus/anchor_reward_derive/late_derive_counter.js');

describe('late anchor reward derive counter', () => {
    const row = {
        reward_type: 'anchor_archive',
        round_reference: 42,
        publisher: 'publisher-key',
        snapshot_block: 100
    };
    const mirrorMaturity = 10;

    it('measures derives at, before, and after the theoretical watermark', () => {
        assert.strictEqual(deriveLateness(row, 110, mirrorMaturity), 0);
        assert.strictEqual(deriveLateness(row, 109, mirrorMaturity), -1);
        assert.strictEqual(deriveLateness(row, 115, mirrorMaturity), 5);
    });

    it('logs one diagnostic with reward identity when the derive is late', () => {
        const logger = { info: sinon.stub() };

        assert.strictEqual(recordLateDerive(logger, row, 115, mirrorMaturity),
                           deriveLateness(row, 115, mirrorMaturity));
        sinon.assert.calledOnce(logger.info);
        const message = logger.info.firstCall.args[0];
        assert.match(message, /anchor_archive/);
        assert.match(message, /42/);
        assert.match(message, /publisher-key/);
        assert.match(message, /5/);
    });

    it('does not log for an on-time or early derive', () => {
        const logger = { info: sinon.stub() };

        for(const blockIndex of [110, 109]){
            assert.strictEqual(recordLateDerive(logger, row, blockIndex, mirrorMaturity),
                               deriveLateness(row, blockIndex, mirrorMaturity));
        }
        sinon.assert.notCalled(logger.info);
    });

    it('returns lateness even when diagnostic logging throws', () => {
        const logger = { info: sinon.stub().throws(new Error('logger unavailable')) };

        assert.doesNotThrow(() => {
            assert.strictEqual(recordLateDerive(logger, row, 115, mirrorMaturity), 5);
        });
        sinon.assert.calledOnce(logger.info);
    });
});
