/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
const fs = require('fs');
const path = require('path');

const DOCKERFILE = fs.readFileSync(path.join(__dirname, '../../../../Dockerfile'), 'utf8');
const BIN_COPIES = [
    'COPY ./bin/archive_heads_by_author.js /XChainIndexer/bin/archive_heads_by_author.js',
    'COPY ./bin/bench_net_balance.js /XChainIndexer/bin/bench_net_balance.js',
    'COPY ./bin/measure_vm_snapshot_bytes.js /XChainIndexer/bin/measure_vm_snapshot_bytes.js',
    'COPY ./bin/retroactive-go.js /XChainIndexer/bin/retroactive-go.js',
];

function hasBinCopyBlock(dockerfile){
    return dockerfile.split('\n').some((line, index, lines) =>
        BIN_COPIES.every((copy, offset) => lines[index + offset] === copy));
}

describe('retroactive go command ships in the image @regression @tier1', function () {
    it('copies retroactive-go.js beside the other bin scripts', function () {
        assert.ok(hasBinCopyBlock(DOCKERFILE));
    });

    it('fails when the retroactive go COPY is omitted', function () {
        const withoutRetroactiveGo = DOCKERFILE.replace(BIN_COPIES[3] + '\n', '');
        assert.notStrictEqual(withoutRetroactiveGo, DOCKERFILE);
        assert.strictEqual(hasBinCopyBlock(withoutRetroactiveGo), false);
    });
});
