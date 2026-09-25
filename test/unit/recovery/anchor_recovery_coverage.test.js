'use strict';

// Copyright © 2025–2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const lifecycle = require('../../../src/hub/table_lifecycle.js');
const AnchorRecovery = require('../../../bin/recovery.js');
const { siblingCheckout } = require('../../helpers/sibling_checkout.js');

const ROOT = path.resolve(__dirname, '../../..');
const VALID_POLICIES = new Set(['archive', 'none']);

function quorumHubMirrors(registry){
    return registry.allTables().filter(row =>
        row.replication === 'hub-mirror' &&
        row.hashed && Array.isArray(row.hashed.classes) &&
        row.hashed.classes.includes('quorum'));
}

function recoverySources(){
    const parts = fs.readdirSync(path.join(ROOT, 'bin', 'recovery'))
        .filter(name => name.endsWith('.js'))
        .map(name => path.join(ROOT, 'bin', 'recovery', name));
    return [path.join(ROOT, 'bin', 'recovery.js'), ...parts]
        .map(file => fs.readFileSync(file, 'utf8'))
        .join('\n');
}

function insertPattern(table){
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('\\bINSERT\\s+(?:IGNORE\\s+)?INTO\\s+`?' + escaped + '`?\\b', 'i');
}

describe('anchor archive recovery registry coverage @regression @tier1', function () {
    it('classifies every quorum-class hub mirror with a valid recovery policy', function () {
        const rows = quorumHubMirrors(lifecycle);
        assert.ok(rows.length > 0, 'the quorum hub-mirror selection must not be vacuous');

        for(const row of rows){
            assert.ok(VALID_POLICIES.has(row.anchorRecovery),
                row.table + ' must declare anchorRecovery as archive or none');
            if(row.anchorRecovery === 'none'){
                assert.ok(typeof row.anchorRecoveryNote === 'string' && row.anchorRecoveryNote.trim(),
                    row.table + ' declares anchorRecovery none without an anchorRecoveryNote');
            }
        }
    });

    it('exports the archive policy rows through anchorRecoveryTables()', function () {
        const declared = quorumHubMirrors(lifecycle)
            .filter(row => row.anchorRecovery === 'archive')
            .map(row => row.table);
        assert.deepStrictEqual(lifecycle.anchorRecoveryTables(), declared);
    });

    it('has an INSERT writer for every archive recovery table', function () {
        const source = recoverySources();
        for(const table of lifecycle.anchorRecoveryTables()){
            assert.ok(insertPattern(table).test(source),
                table + ' is declared for archive recovery but bin/recovery.js and bin/recovery/ contain no INSERT writer');
        }
    });

    it('derives the recovery run header from anchorRecoveryTables()', async function () {
        const lines = [];
        await new AnchorRecovery({ doQuery: async () => [] }, { log: line => lines.push(String(line)) }).run();
        assert.strictEqual(lines[0],
            'recovery: archive-backed hub mirrors: ' + lifecycle.anchorRecoveryTables().join(', '));
    });

    it('the xchain-sync registry copy declares the same recovery policies', function () {
        const syncRoot = process.env.XCHAIN_SYNC_PATH
            ? path.resolve(process.env.XCHAIN_SYNC_PATH)
            : path.resolve(ROOT, '..', 'xchain-sync');
        const syncRegistryPath = path.join(syncRoot, 'src', 'table_lifecycle.js');
        const verdict = siblingCheckout(__dirname, syncRegistryPath);
        if(!verdict.usable){
            if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1'){
                throw new Error('anchor recovery twin guard cannot run: ' + verdict.reason +
                    ' (check out xchain-sync or set XCHAIN_SYNC_PATH)');
            }
            this.skip();
            return;
        }

        const syncLifecycle = require(syncRegistryPath);
        for(const row of quorumHubMirrors(lifecycle)){
            const twin = syncLifecycle.entry(row.table);
            assert.ok(twin, row.table + ' is absent from the xchain-sync lifecycle registry');
            assert.strictEqual(twin.anchorRecovery, row.anchorRecovery,
                row.table + ' has different anchorRecovery values in xchain-indexer and xchain-sync');
            assert.strictEqual(twin.anchorRecoveryNote, row.anchorRecoveryNote,
                row.table + ' has different anchorRecoveryNote values in xchain-indexer and xchain-sync');
        }
    });
});
