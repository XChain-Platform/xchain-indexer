// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const fixturePath = path.resolve(__dirname, '../../fixtures/multipart_file.json');
const authorityPath = path.resolve(__dirname,
    '../../../../xchain-documentation/protocol/test-vectors/multipart_file.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

describe('vendored multipart FILE vectors', function () {
    it('carries a non-empty vector set', function () {
        assert.ok(Array.isArray(fixture.vectors) && fixture.vectors.length > 0);
    });

    it('is byte-identical to the documentation authority when available', function () {
        const verdict = siblingCheckout(__dirname, authorityPath);
        if (!verdict.usable) return skipOrFail(this, verdict, 'the indexer multipart FILE vectors byte-identity guard');
        assert.deepStrictEqual(fs.readFileSync(fixturePath), fs.readFileSync(authorityPath),
            'multipart FILE vectors drifted; edit the documentation authority and re-vendor every copy');
    });
});
