// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const anchorDir = path.resolve(__dirname, '../../../../src/actions/anchor');

describe('ANCHOR DOGE attestation pass removal @regression @tier3', function () {
    it('keeps reward settlement and publisher-attestation quorum code absent', function () {
        assert.strictEqual(fs.existsSync(path.join(anchorDir, 'settle.js')), false);

        const quorumPath = path.join(anchorDir, 'quorum.js');
        const quorumSource = fs.readFileSync(quorumPath, 'utf8');

        assert.doesNotMatch(quorumSource, /headAttestationMet|bundleAttestationMet/);
    });
});
