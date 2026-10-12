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
 ********************************************************************/

'use strict';

const assert = require('assert');
const {
    applyFileAndBroadcastLimits,
    applyMessageMethods,
    applyMessageAndPollLimits,
} = require('../../../src/config/message_limits.js');

const CASES = [
    [applyFileAndBroadcastLimits, {
        MAX_FILE_NAME_LENGTH:         250,
        MAX_FILE_TYPE_LENGTH:         255,
        MAX_FILE_TITLE_LENGTH:        250,
        MAX_BROADCAST_MESSAGE_LENGTH: 250,
        MAX_BROADCAST_VALUE_LENGTH:   25,
        MAX_BROADCAST_FEE_LENGTH:     11,
    }],
    [applyMessageMethods, {
        MESSAGE_ENCRYPTION_METHODS: [1, 2, 3],
        SLEEP_IMMEDIATE_METHODS:    [-1, 0],
    }],
    [applyMessageAndPollLimits, {
        MAX_MESSAGE_LENGTH:     1048576,
        MAX_MESSAGE_KEY_LENGTH: 1048576,
        POLL_DEPOSIT_MIN:       '0',
    }],
];

describe('config message limits', function(){
    for(const [applyLimits, expected] of CASES){
        it(`${applyLimits.name} sets exactly its consensus keys and values`, function(){
            const config = {};
            applyLimits(config);
            assert.deepStrictEqual(config, expected);
        });
    }

    it('keeps every scalar numeric limit a positive integer', function(){
        const limits = CASES.flatMap(([, expected]) => Object.values(expected));
        const numericLimits = limits.filter(value => typeof value === 'number');
        for(const limit of numericLimits){
            assert(Number.isInteger(limit) && limit > 0, `${limit} must be a positive integer`);
        }
    });
});
