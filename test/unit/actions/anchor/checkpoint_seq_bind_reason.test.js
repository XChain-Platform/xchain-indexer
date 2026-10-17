// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const { checkpointSeqBindReason } = require('../../../../src/actions/anchor/validate.js');

function reason(checkpointSeq, snapshotBlock){
    return checkpointSeqBindReason({
        CHECKPOINT_SEQ: checkpointSeq,
        SNAPSHOT_BLOCK: snapshotBlock
    });
}

describe('ANCHOR checkpoint sequence binding reason', function () {
    it('accepts equal canonical decimal strings through the safe-integer ceiling', function () {
        for(const value of ['0', '900', String(Number.MAX_SAFE_INTEGER)])
            assert.strictEqual(reason(value, value), null);
    });

    it('rejects unequal canonical values and names CHECKPOINT_SEQ', function () {
        assert.match(reason('901', '900'), /^CHECKPOINT_SEQ \(/);
    });

    it('rejects leading-zero values even when they are equal', function () {
        assert.match(reason('0900', '0900'), /^CHECKPOINT_SEQ \(/);
    });

    it('rejects signed values', function () {
        assert.match(reason('-1', '-1'), /^CHECKPOINT_SEQ \(/);
        assert.match(reason('+1', '+1'), /^CHECKPOINT_SEQ \(/);
    });

    it('rejects non-digit values', function () {
        assert.match(reason('9a', '9a'), /^CHECKPOINT_SEQ \(/);
    });

    it('rejects either missing field', function () {
        assert.match(reason(undefined, '900'), /^CHECKPOINT_SEQ \(/);
        assert.match(reason('900', undefined), /^SNAPSHOT_BLOCK \(/);
    });

    it('rejects values above Number.MAX_SAFE_INTEGER', function () {
        assert.match(reason('9007199254740992', '9007199254740992'), /^CHECKPOINT_SEQ \(/);
        assert.match(reason('900', '9007199254740992'), /^SNAPSHOT_BLOCK \(/);
    });
});
