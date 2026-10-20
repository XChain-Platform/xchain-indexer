'use strict';

// The xchain-sync copy of the utf8mb4 inventory is generated from the canonical file by
// bin/sync-utf8mb4-columns.js. These tests drive the real script against temporary
// checkouts so a stale, missing or mis-rendered copy is caught here, not at a replica halt.

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const sync = require('../../../bin/sync-utf8mb4-columns.js');

const CANONICAL = path.resolve(__dirname, '../../../src/chain/utf8mb4_columns.js');

describe('utf8mb4 inventory sync to xchain-sync', function(){
    let root, indexerRoot, syncRoot;

    beforeEach(function(){
        root        = fs.mkdtempSync(path.join(os.tmpdir(), 'utf8mb4-sync-'));
        indexerRoot = path.join(root, 'xchain-indexer');
        syncRoot    = path.join(root, 'xchain-sync');
        fs.mkdirSync(path.join(indexerRoot, 'src', 'chain'), { recursive: true });
        fs.mkdirSync(syncRoot, { recursive: true });
        fs.copyFileSync(CANONICAL, path.join(indexerRoot, 'src', 'chain', 'utf8mb4_columns.js'));
    });

    afterEach(function(){
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('marks the canonical file as the canonical inventory', function(){
        assert.ok(fs.readFileSync(CANONICAL, 'utf8').includes('CANONICAL INVENTORY'));
    });

    it('renders a copy that differs from the canonical file only in the provenance paragraph', function(){
        const canonical = fs.readFileSync(CANONICAL, 'utf8');
        const copy      = sync.renderCopy(canonical);
        const parts     = sync.splitParagraph(canonical);
        const removed   = parts.lines.slice(parts.start, parts.end);
        const kept      = parts.lines.filter((l, i) => i < parts.start || i >= parts.end);
        assert.deepStrictEqual(copy.split('\n').filter(l => !sync.COPY_PARAGRAPH.includes(l)), kept);
        assert.ok(removed.length > 0);
        assert.ok(copy.includes('SYNCED COPY'));
        assert.ok(!copy.includes('CANONICAL INVENTORY'));
    });

    it('reports a missing copy, writes it, then reports it in sync', function(){
        assert.strictEqual(sync.checkCopy(indexerRoot, syncRoot).ok, false);
        const written = sync.writeCopy(indexerRoot, syncRoot);
        assert.strictEqual(written, path.join(syncRoot, 'src', 'schema', 'utf8mb4_columns.js'));
        assert.deepStrictEqual(sync.checkCopy(indexerRoot, syncRoot), { ok: true, reason: '' });
    });

    it('reports a stale copy after the canonical file changes', function(){
        sync.writeCopy(indexerRoot, syncRoot);
        const canon = path.join(indexerRoot, 'src', 'chain', 'utf8mb4_columns.js');
        fs.writeFileSync(canon, fs.readFileSync(canon, 'utf8').replace("column: 'code',", "column: 'code_x',"));
        const res = sync.checkCopy(indexerRoot, syncRoot);
        assert.strictEqual(res.ok, false);
        assert.match(res.reason, /^stale /);
    });

    it('reports a hand-edited copy as stale', function(){
        const copy = sync.writeCopy(indexerRoot, syncRoot);
        fs.appendFileSync(copy, '// drift\n');
        assert.strictEqual(sync.checkCopy(indexerRoot, syncRoot).ok, false);
    });

    it('refuses to render when the canonical file lost its provenance paragraph', function(){
        assert.throws(() => sync.renderCopy('module.exports = {};\n'), /no "\* CANONICAL INVENTORY" paragraph|CANONICAL INVENTORY/);
    });

    it('exits 1 from --check on a stale copy and 0 after --write', function(){
        const { spawnSync } = require('child_process');
        const script = path.resolve(__dirname, '../../../bin/sync-utf8mb4-columns.js');
        // The script resolves its indexer root from its own location, so run a copy of it
        // placed inside the temporary indexer checkout.
        fs.mkdirSync(path.join(indexerRoot, 'bin'), { recursive: true });
        const local = path.join(indexerRoot, 'bin', 'sync-utf8mb4-columns.js');
        fs.copyFileSync(script, local);
        const env = { ...process.env, XCHAIN_SYNC_SOURCE: syncRoot };
        assert.strictEqual(spawnSync(process.execPath, [local, '--check'], { env }).status, 1);
        assert.strictEqual(spawnSync(process.execPath, [local, '--write'], { env }).status, 0);
        assert.strictEqual(spawnSync(process.execPath, [local, '--check'], { env }).status, 0);
        assert.strictEqual(spawnSync(process.execPath, [local], { env }).status, 64);
    });
});
