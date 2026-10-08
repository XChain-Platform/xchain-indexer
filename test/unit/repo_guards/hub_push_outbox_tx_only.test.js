'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Every pending_hub_pushes row is written inside the caller's open transaction, so a
// crash or a rolled-back block can neither lose a delivery nor leave an orphan row.
// This pins that to ONE writer that runs on the transaction connection.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(REPO, 'src');
const OUTBOX_WRITER = 'src/db/hub_pushes/index.js';
const OUTBOX_INSERT = /INSERT\s+(?:IGNORE\s+)?INTO\s+`?pending_hub_pushes`?/gi;

function javascriptFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...javascriptFiles(absolute));
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
    }
    return files.sort();
}

// The method body around one INSERT: from the method's `async` to its closing brace.
function enclosingMethod(text, at) {
    const start = text.lastIndexOf('async ', at);
    const end = text.indexOf('\n    },', at);
    return text.slice(start, end === -1 ? text.length : end);
}

// Every outbox INSERT in the given { rel: text } map, with the method that runs it.
function outboxInserts(sources) {
    const found = [];
    for (const [rel, text] of Object.entries(sources)) {
        for (const m of text.matchAll(OUTBOX_INSERT))
            found.push({ rel, method: enclosingMethod(text, m.index) });
    }
    return found;
}

describe('hub push outbox: one transactional writer @regression', function () {
    const sources = {};
    for (const file of javascriptFiles(SRC))
        sources[path.relative(REPO, file).split(path.sep).join('/')] = fs.readFileSync(file, 'utf8');

    it('writes pending_hub_pushes rows from exactly one place in src', function () {
        const inserts = outboxInserts(sources);
        assert.deepStrictEqual(inserts.map(i => i.rel), [OUTBOX_WRITER],
            'outbox rows must go through enqueueHubPushTx inside the block or rollback transaction');
    });

    it('runs the outbox INSERT on the transaction connection, never the pool', function () {
        const [insert] = outboxInserts(sources);
        assert.ok(insert && /this\.doQuery\(/.test(insert.method),
            'the outbox writer must run its INSERT through doQuery (the open transaction)');
        assert.ok(!/poolQuery\(/.test(insert.method),
            'a pooled outbox INSERT commits outside the block transaction and can lose or orphan a push');
    });

    it('sees a pooled outbox writer when one exists (negative control)', function () {
        const pooled = 'module.exports = {\n    async enqueueHubPush(t, p){\n' +
            '        let q = `INSERT INTO pending_hub_pushes (push_type) VALUES (?)`;\n' +
            '        await this.poolQuery(q, [t]);\n    },\n};\n';
        const [insert] = outboxInserts({ 'src/x.js': pooled });
        assert.ok(insert && /poolQuery\(/.test(insert.method), 'the guard must be able to fail');
    });
});
