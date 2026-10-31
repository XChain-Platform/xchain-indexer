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

// The Node patch the image ships must be the patch CI tests.
//
// The image bundles xchain-vm, whose runtime gate compares engine strings only,
// so a base-image bump can move libuv, OpenSSL or the thread stack isolated-vm
// inherits while CI keeps passing on the old patch. Bump the Dockerfile FROM and
// the ci.yml node-version together.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../..');

/** Every full node:<x.y.z> patch named by a FROM line. */
function imagePatches(dockerfile) {
    return [...dockerfile.matchAll(/^FROM\s+node:(\d+\.\d+\.\d+)\b/gm)].map((m) => m[1]);
}

/** Every node-version value in a workflow, skipping comment lines. */
function workflowPatches(yaml) {
    return [...yaml.matchAll(/^[ \t]*node-version:[ \t]*["']?([^"'\s#]+)/gm)].map((m) => m[1]);
}

describe('packaging: image Node patch matches CI', function () {
    const image = imagePatches(fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8'));
    const ci = workflowPatches(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'));

    it('pins every Dockerfile FROM to one full node patch', function () {
        assert.ok(image.length > 0, 'no FROM node:<x.y.z> line in the Dockerfile');
        assert.strictEqual(new Set(image).size, 1, 'FROM lines name more than one Node patch: ' + image.join(', '));
    });

    it('tests in ci.yml on the patch the image ships', function () {
        assert.ok(ci.length > 0, 'no node-version in .github/workflows/ci.yml');
        assert.deepStrictEqual([...new Set(ci)], [image[0]]);
    });
});
