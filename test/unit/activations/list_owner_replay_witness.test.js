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

function realHistoryCorpus() {
    const history = [
        {
            block_index: 67908224,
            ledger: '26181a31aa23e7e93d819370d8920095b45553792615f738bb871845300ad1d4',
            actions: 'a165ff7a30cdb559e6df78124118b0a047ba101628fd9946e9bfd79b9ecaaf9a',
            contracts: 'ae10376be42286b97c94fe9ff466b9dbb15476df87d7cbdf3cb3ac6802b20759',
            state: 'ac3e288a35862f1078e7a992bb8d945b080864a951d71bcee871801e009a8e61',
        },
        {
            block_index: 67908225,
            ledger: '7ae20a0fa6160c5dc7a2c720ac3e639e0fc39e565d613b9675dd1ca59f29a65f',
            actions: 'f5ebb3de1d980a1df2f8aeb9a15db0bde3e76caaafd65d1fcf417ad91504e476',
            contracts: '8f43744a03f656cd1e1e46839e9d24afdbf232f67598c76a1bfee62e86dcbd04',
            state: '0f5d4bdc14a98e62ae4927ef53ec09406e815faba5c6deea7f962c2241b75e0f',
        },
        {
            block_index: 67908226,
            ledger: 'f0290ef03de330339902ca46d0adf1a2ab9cbe3cbdaa41d0ed2de2decfdaec5e',
            actions: 'c03e91a279125b7007bbe51c3697ab4d6fedc209d7df48b0cd014e39f72c8c54',
            contracts: 'f830e6d51973063af133b9deb20ca44e8906fde4065c142ada6e08ed9f7bc073',
            state: '682f8522573a48a52e92dc51641b13d932c032b0b7d9af8a9299f2903c76c1b6',
        },
    ];
    return {
        format: witness.RESOLVED_CORPUS_FORMAT,
        network: 'testnet',
        capture: {
            id: 'doge-testnet-list-1947-block-67908225',
            source: 'indexer-history',
            chain: 'DOGE',
            network: 'testnet',
            boundary_block: 67908225,
            list_action_indexes: [1947],
        },
        sides: {
            legacy: JSON.parse(JSON.stringify(history)),
            off: JSON.parse(JSON.stringify(history)),
        },
    };
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
            assert.match(result.stdout, /SYNTHETIC: raw record corpus is not indexer-history evidence/);
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

    it('passes the pinned two-sided corpus captured at a real LIST history boundary', function () {
        const parent = temporaryDirectory('real-history');
        const corpus = writeFixture(parent, realHistoryCorpus());
        const replay = witness.readCorpusFile(corpus, 'testnet', witness.gateValues().testnet);
        assert.deepStrictEqual(replay.fields, witness.HASH_FIELDS);
        assert.strictEqual(replay.capture.chain, 'DOGE');
        assert.strictEqual(replay.capture.boundary_block, 67908225);
        const result = runTool(['--network', 'testnet', '--corpus-file', corpus,
            '--workdir', path.join(parent, 'work')]);
        assert.strictEqual(result.status, witness.EXIT.PASS, result.stdout + result.stderr);
        assert.match(result.stdout, /hash-identical across 3 below-the-flag blocks/);
        assert.match(result.stdout, /verified pinned indexer-history capture doge-testnet-list-1947-block-67908225/);
        fs.rmSync(parent, { recursive: true, force: true });
    });

    it('refuses arbitrary duplicated hashes relabeled as the real history capture', function () {
        const parent = temporaryDirectory('fake-history');
        const value = realHistoryCorpus();
        for (const side of ['legacy', 'off']) {
            for (const record of value.sides[side]) {
                for (const field of witness.HASH_FIELDS) record[field] = 'a'.repeat(64);
            }
        }
        const corpus = writeFixture(parent, value);
        const result = runTool(['--network', 'testnet', '--corpus-file', corpus,
            '--workdir', path.join(parent, 'work')]);
        assert.strictEqual(result.status, witness.EXIT.REFUSED, result.stdout + result.stderr);
        assert.match(result.stdout, /does not match pinned indexer-history digest/);
        fs.rmSync(parent, { recursive: true, force: true });
    });

    it('refuses history capture metadata on the unauthenticated raw format', function () {
        const parent = temporaryDirectory('raw-history-label');
        const value = fixture('testnet', false);
        value.capture = realHistoryCorpus().capture;
        const corpus = writeFixture(parent, value);
        const result = runTool(['--network', 'testnet', '--corpus-file', corpus,
            '--workdir', path.join(parent, 'work')]);
        assert.strictEqual(result.status, witness.EXIT.REFUSED, result.stdout + result.stderr);
        assert.match(result.stdout, /capture metadata requires format resolved-four-hash-v1/);
        fs.rmSync(parent, { recursive: true, force: true });
    });

    it('finds the exact changed commitment after loading the authenticated history corpus', function () {
        const parent = temporaryDirectory('real-history-mismatch');
        const corpus = writeFixture(parent, realHistoryCorpus());
        const replay = witness.readCorpusFile(corpus, 'testnet', witness.gateValues().testnet);
        replay.off[1].state = '1' + replay.off[1].state.slice(1);
        const divergence = witness.firstDivergence(replay.legacy, replay.off, replay.fields);
        assert.strictEqual(divergence.block, 67908225);
        assert.strictEqual(divergence.field, 'state');
        fs.rmSync(parent, { recursive: true, force: true });
    });

    it('refuses metadata that moves the pinned history boundary', function () {
        const parent = temporaryDirectory('real-history-refusal');
        const value = realHistoryCorpus();
        value.capture.boundary_block = 67908227;
        const corpus = writeFixture(parent, value);
        const result = runTool(['--network', 'testnet', '--corpus-file', corpus,
            '--workdir', path.join(parent, 'work')]);
        assert.strictEqual(result.status, witness.EXIT.REFUSED, result.stdout + result.stderr);
        assert.match(result.stdout, /has untrusted boundary_block/);
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
