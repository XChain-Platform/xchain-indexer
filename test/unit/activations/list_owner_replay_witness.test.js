'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const witness = require('../../../bin/verify-list-owner-replay-equivalence.js');

const TOOL = path.resolve(__dirname, '../../../bin/verify-list-owner-replay-equivalence.js');

function temporaryDirectory(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'list-owner-' + label + '-'));
}

function fixture(network, changed, holdMs) {
    const legacy = [
        { block_index: 10, action: 'LIST', status: 'valid', items: ['A'] },
        { block_index: 11, action: 'LIST', status: 'valid', items: ['A', 'B'] },
    ];
    const off = JSON.parse(JSON.stringify(legacy));
    if (changed) off[1].items[1] = 'PERTURBED';
    const value = { network, sides: { legacy, off } };
    if (holdMs) value._hold_ms = holdMs;
    return value;
}

function writeFixture(directory, value) {
    const filename = path.join(directory, 'corpus.json');
    fs.writeFileSync(filename, JSON.stringify(value) + '\n');
    return filename;
}

function runTool(args) {
    return spawnSync(process.execPath, [TOOL].concat(args), { encoding: 'utf8' });
}

function runInterrupt(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [TOOL].concat(args), { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let killed = false;
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('witness did not reach its hold point: ' + stdout + stderr));
        }, 10000);
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (!killed && stdout.includes('READY:')) {
                killed = true;
                child.kill('SIGTERM');
            }
        });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (status, signal) => {
            clearTimeout(timer);
            resolve({ status, signal, stdout, stderr });
        });
    });
}

describe('LIST owner replay witness: gate and hash comparison', function () {
    it('reads the never-arm values for public corpora and genesis-active regtest value', function () {
        const gates = witness.gateValues();
        assert.strictEqual(gates.mainnet, 9999999999);
        assert.strictEqual(gates.testnet, 9999999999);
        assert.strictEqual(gates.regtest, 0);
    });

    it('builds matching hash chains from byte-equivalent two-sided records', function () {
        const corpus = fixture('testnet', false);
        const legacy = witness.buildHashChain(corpus.sides.legacy);
        const off = witness.buildHashChain(corpus.sides.off);
        assert.strictEqual(witness.firstDivergence(legacy, off), null);
        assert.strictEqual(legacy.length, 2);
    });

    it('names the first changed record as a hash mismatch', function () {
        const corpus = fixture('testnet', true);
        const divergence = witness.firstDivergence(
            witness.buildHashChain(corpus.sides.legacy),
            witness.buildHashChain(corpus.sides.off)
        );
        assert.strictEqual(divergence.block, 11);
        assert.strictEqual(divergence.field, 'hash');
        assert.notStrictEqual(divergence.legacy, divergence.off);
    });

    it('rolls back only the executable general-owner checks in a legacy tree', function () {
        const source = fs.readFileSync(path.join(__dirname, '../../../src/actions/list.js'), 'utf8');
        const legacy = witness.rollBackListOwner(source);
        assert.ok(!legacy.includes("gateRegistry.activeAt('" + witness.GATE + "'"));
        assert.ok(legacy.includes('if(bridgeRoles.length){'));
        assert.ok(!legacy.includes("error = 'invalid: LIST_ACTION_INDEX (not owner)'"));
        assert.ok(legacy.includes("error = 'invalid: LIST_ACTION_INDEX (bridge-owned)'"));
    });
});

describe('LIST owner replay witness: refusal and retention', function () {
    for (const keep of [false, true]) {
        it('refuses regtest and ' + (keep ? 'keeps' : 'cleans') + ' its workdir', function () {
            const parent = temporaryDirectory('refusal');
            const workdir = path.join(parent, 'work');
            const corpus = writeFixture(parent, fixture('regtest', false));
            const args = ['--network', 'regtest', '--corpus-file', corpus, '--workdir', workdir];
            if (keep) args.push('--keep');
            const result = runTool(args);
            assert.strictEqual(result.status, witness.EXIT.REFUSED, result.stdout + result.stderr);
            assert.match(result.stdout, /REGTEST_CORPUS_ABOVE_LIST_OWNER_FLAG/);
            assert.match(result.stdout, /regtest activation is 0/);
            assert.strictEqual(fs.existsSync(workdir), keep);
            fs.rmSync(parent, { recursive: true, force: true });
        });
    }
});

describe('LIST owner replay witness: success and retention', function () {
    for (const keep of [false, true]) {
        it('passes identical input and ' + (keep ? 'keeps' : 'cleans') + ' its workdir', function () {
            const parent = temporaryDirectory('success');
            const workdir = path.join(parent, 'work');
            const corpus = writeFixture(parent, fixture('testnet', false));
            const args = ['--network', 'testnet', '--corpus-file', corpus, '--workdir', workdir];
            if (keep) args.push('--keep');
            const result = runTool(args);
            assert.strictEqual(result.status, witness.EXIT.PASS, result.stdout + result.stderr);
            assert.match(result.stdout, /PASS: LEGACY and OFF are hash-identical across 2 below-the-flag blocks/);
            assert.strictEqual(fs.existsSync(workdir), keep);
            fs.rmSync(parent, { recursive: true, force: true });
        });
    }

    it('reports MISMATCH and exits nonzero for a perturbed record', function () {
        const parent = temporaryDirectory('mismatch');
        const original = writeFixture(parent, fixture('mainnet', false));
        const corpus = path.join(parent, 'perturbed.json');
        fs.copyFileSync(original, corpus);
        const changed = JSON.parse(fs.readFileSync(corpus, 'utf8'));
        changed.sides.off[1].items[1] = 'PERTURBED';
        fs.writeFileSync(corpus, JSON.stringify(changed) + '\n');
        const result = runTool(['--network', 'mainnet', '--corpus-file', corpus,
            '--workdir', path.join(parent, 'work')]);
        assert.strictEqual(result.status, witness.EXIT.FAIL, result.stdout + result.stderr);
        assert.match(result.stdout, /MISMATCH: first divergence at block 11 on hash/);
        fs.copyFileSync(original, corpus);
        const restored = spawnSync('cmp', [original, corpus], { encoding: 'utf8' });
        assert.strictEqual(restored.status, 0, restored.stdout + restored.stderr);
        fs.rmSync(parent, { recursive: true, force: true });
    });

    it('drops scratch schemas only when retention is off', async function () {
        const dropped = [];
        const parent = temporaryDirectory('schema-cleanup');
        const cleanWorkdir = path.join(parent, 'clean');
        fs.mkdirSync(cleanWorkdir);
        await witness.cleanupState({
            workdir: cleanWorkdir, keep: false, children: new Set(), db: {}, options: {},
            schemas: ['list_owner_replay_btc_legacy', 'list_owner_replay_btc_off'],
            dropSchemas: async (_options, _db, schemas) => { dropped.push(...schemas); },
        }, 'unit success');
        assert.deepStrictEqual(dropped, ['list_owner_replay_btc_legacy', 'list_owner_replay_btc_off']);
        assert.ok(!fs.existsSync(cleanWorkdir));

        const keptWorkdir = path.join(parent, 'keep');
        fs.mkdirSync(keptWorkdir);
        await witness.cleanupState({
            workdir: keptWorkdir, keep: true, children: new Set(), db: {}, options: {},
            schemas: ['list_owner_replay_btc_legacy', 'list_owner_replay_btc_off'],
            dropSchemas: async () => { throw new Error('retained schemas must not be dropped'); },
        }, 'unit success');
        assert.ok(fs.existsSync(keptWorkdir));
        fs.rmSync(parent, { recursive: true, force: true });
    });
});

describe('LIST owner replay witness: SIGTERM and retention', function () {
    this.timeout(20000);
    for (const keep of [false, true]) {
        it('handles SIGTERM and ' + (keep ? 'keeps' : 'cleans') + ' its workdir', async function () {
            const parent = temporaryDirectory('signal');
            const workdir = path.join(parent, 'work');
            const corpus = writeFixture(parent, fixture('testnet', false, 30000));
            const args = ['--network', 'testnet', '--corpus-file', corpus, '--workdir', workdir];
            if (keep) args.push('--keep');
            const result = await runInterrupt(args);
            assert.strictEqual(result.status, 143, result.stdout + result.stderr + ' signal=' + result.signal);
            assert.strictEqual(fs.existsSync(workdir), keep);
            fs.rmSync(parent, { recursive: true, force: true });
        });
    }
});
