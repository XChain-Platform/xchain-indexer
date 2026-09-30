#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * BELOW-THE-FLAG REPLAY WITNESS for LIST_OWNER_ACTIVATION.
 *
 * The gate is deliberately inert on mainnet and testnet. This tool replays one
 * of those corpora through two isolated trees: LEGACY removes only the general
 * list-owner check, while OFF is the current tree with its natural inert gate.
 * The four resolved block hashes must agree at every block.
 *
 * Regtest is refused by name. Its gate is active at height zero, so its entire
 * corpus is above the flag and cannot prove below-the-flag replay identity.
 *
 * A JSON corpus file is also accepted for offline drives and unit tests. A raw
 * record corpus has this shape:
 *
 *   {"network":"testnet","sides":{"legacy":[records],"off":[records]}}
 *
 * Each record needs a nonnegative integer block_index. The remaining fields are
 * canonicalized and folded into a SHA-256 chain independently for each side.
 * This mode is synthetic and is not accepted as indexer-history evidence.
 * Archived indexer output instead names format "resolved-four-hash-v1" and a
 * pinned capture id. The tool verifies the capture metadata and content digest
 * before comparing its ledger, actions, contracts and state commitments. A
 * database corpus uses the production indexer and the same four-hash chain.
 *
 * USAGE
 *   node bin/verify-list-owner-replay-equivalence.js \
 *        --network testnet --corpus-file /path/to/two-sided.json
 *   node bin/verify-list-owner-replay-equivalence.js \
 *        --coin BTC --network mainnet --decoder-db decoder_schema
 *
 * Options: --schema-prefix <plain_name>, --workdir <dir>, --keep, --dry-run.
 * Database credentials are loaded by dotenv from the project .env and then read
 * through src/config.js. They are never accepted on argv or printed.
 *
 * EXIT: 0 identical, 1 mismatch, 2 refused, 3 vacuous, 64 bad arguments.
 *
 *********************************************************************/

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const GATE = 'list_owner_activation.LIST_OWNER_ACTIVATION';
const SIDE_MARK = '###LIST-OWNER-SIDE###';
const HASH_FIELDS = ['ledger', 'actions', 'contracts', 'state'];
const RESOLVED_CORPUS_FORMAT = 'resolved-four-hash-v1';
const EXIT = Object.freeze({ PASS: 0, FAIL: 1, REFUSED: 2, VACUOUS: 3, USAGE: 64 });
const SCHEMA_NAME = /^[A-Za-z0-9_]+$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
const TRUSTED_HISTORY_CAPTURES = Object.freeze({
    'doge-testnet-list-1947-block-67908225': Object.freeze({
        source: 'indexer-history',
        chain: 'DOGE',
        network: 'testnet',
        boundary_block: 67908225,
        list_action_indexes: Object.freeze([1947]),
        sha256: '61e46aa0146b5c0c558ebf155cbb708e5c060aa871528121f8e99ab89a3b8a20',
    }),
});

class NamedRefusal extends Error {}

let activeCleanup = null;
let signalInProgress = false;

if (require.main === module) {
    if (process.argv.includes('--side')) {
        runDatabaseSide().catch((error) => {
            console.error('SIDE ERROR: ' + ((error && error.stack) || error));
            process.exit(EXIT.FAIL);
        });
    } else {
        installSignalCleanup();
        runCli().then((code) => { process.exitCode = code; }).catch((error) => {
            console.error('ERR ' + ((error && error.stack) || error));
            process.exitCode = EXIT.REFUSED;
        });
    }
}

function installSignalCleanup() {
    const onSignal = (signal) => {
        if (signalInProgress) return;
        signalInProgress = true;
        const code = signal === 'SIGTERM' ? 143 : 130;
        Promise.resolve(activeCleanup ? activeCleanup(signal) : undefined)
            .catch((error) => { console.error('cleanup error: ' + error.message); })
            .finally(() => process.exit(code));
    };
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));
}

function parseArgs(argv) {
    const options = {
        coin: 'BTC', network: null, corpusFile: null, decoderDb: null,
        schemaPrefix: null, workdir: null, keep: false, dryRun: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--coin') options.coin = String(argv[++i] || '').toUpperCase();
        else if (arg === '--network') options.network = String(argv[++i] || '').toLowerCase();
        else if (arg === '--corpus-file') options.corpusFile = argv[++i];
        else if (arg === '--decoder-db') options.decoderDb = argv[++i];
        else if (arg === '--schema-prefix') options.schemaPrefix = argv[++i];
        else if (arg === '--workdir') options.workdir = argv[++i];
        else if (arg === '--keep') options.keep = true;
        else if (arg === '--dry-run') options.dryRun = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else throw Object.assign(new Error('unknown argument: ' + arg), { exitCode: EXIT.USAGE });
    }
    return options;
}

function gateValues() {
    return require(path.join(REPO, 'src', 'protocol_changes.js')).copy(GATE);
}

function validateOptions(options, gates) {
    if (!options.network) throw new NamedRefusal('--network mainnet|testnet is required so the corpus source is explicit');
    if (options.network === 'regtest') {
        throw new NamedRefusal('REGTEST_CORPUS_ABOVE_LIST_OWNER_FLAG: regtest activation is ' + gates.regtest +
            ', so every regtest block is above the flag and proves nothing about below-the-flag replay identity');
    }
    if (!['mainnet', 'testnet'].includes(options.network))
        throw new NamedRefusal('network must be mainnet or testnet, got ' + JSON.stringify(options.network));
    if (Number(gates[options.network]) === 0)
        throw new NamedRefusal(options.network + ' is active from genesis and has no below-the-flag corpus');
    if (Boolean(options.corpusFile) === Boolean(options.decoderDb))
        throw new NamedRefusal('name exactly one corpus source: --corpus-file or --decoder-db');
    if (options.decoderDb && !SCHEMA_NAME.test(String(options.decoderDb)))
        throw new NamedRefusal('--decoder-db must be a plain schema name, got ' + JSON.stringify(options.decoderDb));
    if (options.schemaPrefix && !SCHEMA_NAME.test(String(options.schemaPrefix)))
        throw new NamedRefusal('--schema-prefix must contain only letters, digits and underscore');
}

function canonicalJson(value) {
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
}

function buildHashChain(records) {
    if (!Array.isArray(records)) throw new NamedRefusal('each corpus side must be an array of records');
    let previous = Buffer.alloc(32, 0);
    return records.map((record, position) => {
        if (!record || !Number.isSafeInteger(record.block_index) || record.block_index < 0)
            throw new NamedRefusal('record ' + position + ' needs a nonnegative integer block_index');
        const digest = crypto.createHash('sha256').update(previous).update('\n').update(canonicalJson(record)).digest();
        previous = digest;
        return { block_index: record.block_index, hash: digest.toString('hex') };
    });
}

function resolvedHashChain(records, side) {
    if (!Array.isArray(records)) throw new NamedRefusal('corpus side ' + side + ' must be an array of records');
    let previous = -1;
    return records.map((record, position) => {
        if (!record || !Number.isSafeInteger(record.block_index) || record.block_index < 0)
            throw new NamedRefusal('corpus side ' + side + ' record ' + position +
                ' needs a nonnegative integer block_index');
        if (record.block_index <= previous)
            throw new NamedRefusal('corpus side ' + side + ' block indexes must be strictly increasing');
        previous = record.block_index;
        const output = { block_index: record.block_index };
        for (const field of HASH_FIELDS) {
            if (!HASH_HEX.test(String(record[field] || '')))
                throw new NamedRefusal('corpus side ' + side + ' block ' + record.block_index +
                    ' needs a lowercase 64-hex ' + field + ' hash');
            output[field] = record[field];
        }
        return output;
    });
}

function historyCaptureDigest(network, capture, legacy, off) {
    const payload = {
        format: RESOLVED_CORPUS_FORMAT,
        network,
        capture: {
            id: capture.id,
            source: capture.source,
            chain: capture.chain,
            network: capture.network,
            boundary_block: capture.boundary_block,
            list_action_indexes: capture.list_action_indexes,
        },
        sides: { legacy, off },
    };
    return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function validateHistoryCapture(capture, network, legacy, off) {
    if (!capture || typeof capture.id !== 'string')
        throw new NamedRefusal(RESOLVED_CORPUS_FORMAT + ' requires a pinned capture.id');
    const trusted = TRUSTED_HISTORY_CAPTURES[capture.id];
    if (!trusted)
        throw new NamedRefusal('capture id ' + JSON.stringify(capture.id) + ' is not pinned as indexer history');
    for (const field of ['source', 'chain', 'network', 'boundary_block']) {
        if (capture[field] !== trusted[field])
            throw new NamedRefusal('capture ' + capture.id + ' has untrusted ' + field);
    }
    if (canonicalJson(capture.list_action_indexes) !== canonicalJson(trusted.list_action_indexes))
        throw new NamedRefusal('capture ' + capture.id + ' has untrusted list_action_indexes');
    if (capture.network !== network)
        throw new NamedRefusal('capture network ' + JSON.stringify(capture.network) +
            ' does not match corpus network ' + network);
    for (const [side, chain] of [['legacy', legacy], ['off', off]]) {
        if (!chain.some((record) => record.block_index === capture.boundary_block))
            throw new NamedRefusal('corpus side ' + side + ' does not include capture boundary block ' +
                capture.boundary_block);
    }
    const digest = historyCaptureDigest(network, capture, legacy, off);
    if (digest !== trusted.sha256)
        throw new NamedRefusal('capture ' + capture.id + ' content digest ' + digest +
            ' does not match pinned indexer-history digest');
}

function firstDivergence(chainA, chainB, fields) {
    const comparedFields = fields || ['hash'];
    const length = Math.min(chainA.length, chainB.length);
    for (let i = 0; i < length; i += 1) {
        if (chainA[i].block_index !== chainB[i].block_index) {
            return { block: chainA[i].block_index, field: 'sequence',
                     legacy: chainA[i].block_index, off: chainB[i].block_index };
        }
        for (const field of comparedFields) {
            if (chainA[i][field] !== chainB[i][field]) {
                return { block: chainA[i].block_index, field,
                         legacy: chainA[i][field], off: chainB[i][field] };
            }
        }
    }
    if (chainA.length !== chainB.length)
        return { block: null, field: 'length', legacy: chainA.length, off: chainB.length };
    return null;
}

function readCorpusFile(filename, expectedNetwork, activationHeight) {
    let corpus;
    try { corpus = JSON.parse(fs.readFileSync(path.resolve(filename), 'utf8')); }
    catch (error) { throw new NamedRefusal('cannot read JSON corpus ' + filename + ': ' + error.message); }
    if (corpus.network !== expectedNetwork)
        throw new NamedRefusal('corpus network ' + JSON.stringify(corpus.network) +
            ' does not match --network ' + expectedNetwork);
    const sides = corpus.sides || {};
    let legacy;
    let off;
    let fields;
    let capture = null;
    if (corpus.format === RESOLVED_CORPUS_FORMAT) {
        legacy = resolvedHashChain(sides.legacy, 'legacy');
        off = resolvedHashChain(sides.off, 'off');
        fields = HASH_FIELDS;
        validateHistoryCapture(corpus.capture, corpus.network, legacy, off);
        capture = corpus.capture;
    } else {
        if (corpus.format)
            throw new NamedRefusal('unknown corpus format ' + JSON.stringify(corpus.format));
        if (corpus.capture)
            throw new NamedRefusal('capture metadata requires format ' + RESOLVED_CORPUS_FORMAT);
        legacy = buildHashChain(sides.legacy);
        off = buildHashChain(sides.off);
        fields = ['hash'];
    }
    for (const item of legacy.concat(off)) {
        if (item.block_index >= activationHeight)
            throw new NamedRefusal('corpus block ' + item.block_index + ' is not below activation height ' + activationHeight);
    }
    return { legacy, off, fields, capture, holdMs: Number(corpus._hold_ms || 0) };
}

function rollBackListOwner(source) {
    const edits = [
        ["            let ownerCheck  = gateRegistry.activeAt('list_owner_activation.LIST_OWNER_ACTIVATION', this.config['NETWORK'], null, data['BLOCK_INDEX'], null);\n", ''],
        ['            if(bridgeRoles.length || ownerCheck){', '            if(bridgeRoles.length){'],
        ["                if(!error && ownerCheck && listSource && listSource != data['SOURCE'])\n                    error = 'invalid: LIST_ACTION_INDEX (not owner)';\n", ''],
    ];
    let output = source;
    for (const [before, after] of edits) {
        if (output.split(before).length !== 2)
            throw new NamedRefusal('the LIST owner rollback no longer matches src/actions/list.js exactly');
        output = output.replace(before, after);
    }
    if (output.includes("gateRegistry.activeAt('" + GATE + "'"))
        throw new NamedRefusal('the LEGACY list handler still reads ' + GATE);
    return output;
}

function materializeTrees(workdir) {
    const offRoot = path.join(workdir, 'off');
    const legacyRoot = path.join(workdir, 'legacy');
    for (const root of [offRoot, legacyRoot]) {
        fs.mkdirSync(root, { recursive: true });
        execSync('git archive HEAD | tar -x -C ' + JSON.stringify(root), { cwd: REPO });
        fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
    }
    const legacyList = path.join(legacyRoot, 'src', 'actions', 'list.js');
    fs.writeFileSync(legacyList, rollBackListOwner(fs.readFileSync(legacyList, 'utf8')));
    return { legacyRoot, offRoot };
}

function projectDbConfig(options) {
    require('dotenv').config({ path: path.join(REPO, '.env') });
    process.env.INDEXER_COIN = options.coin;
    process.env.INDEXER_NETWORK = options.network;
    const env = require(path.join(REPO, 'src', 'config.js')).CONFIG_ENV;
    const required = ['DECODER_DB_HOST', 'DECODER_DB_PORT', 'DECODER_DB_USER', 'DECODER_DB_PASS',
                      'INDEXER_DB_HOST', 'INDEXER_DB_PORT', 'INDEXER_DB_USER', 'INDEXER_DB_PASS', 'INDEXER_DB_NAME'];
    const missing = required.filter((key) => env[key] === undefined);
    if (missing.length) throw new NamedRefusal('project config is missing database keys: ' + missing.join(', '));
    if (env.DECODER_DB_HOST !== env.INDEXER_DB_HOST || String(env.DECODER_DB_PORT) !== String(env.INDEXER_DB_PORT) ||
        env.DECODER_DB_USER !== env.INDEXER_DB_USER || env.DECODER_DB_PASS !== env.INDEXER_DB_PASS) {
        throw new NamedRefusal('the replay harness requires decoder and scratch indexer schemas on one configured database server');
    }
    return {
        host: env.INDEXER_DB_HOST, port: String(env.INDEXER_DB_PORT), user: env.INDEXER_DB_USER,
        pass: env.INDEXER_DB_PASS, baseDb: env.INDEXER_DB_NAME,
    };
}

function sideEnvironment(options, db, root, schema, key) {
    return Object.assign({}, process.env, {
        LO_SIDE_KEY: key, LO_SIDE_ROOT: root,
        INDEXER_COIN: options.coin, INDEXER_NETWORK: options.network,
        TEST_DB_HOST: db.host, TEST_DB_PORT: db.port, TEST_DB_USER: db.user, TEST_DB_PASS: db.pass,
        TEST_DECODER_DB: options.decoderDb, TEST_INDEXER_DB: schema,
    });
}

async function runDatabaseSide() {
    const root = process.env.LO_SIDE_ROOT;
    const key = process.env.LO_SIDE_KEY;
    if (!root || !key) throw new Error('side root and key are required');
    const launcher = require(path.join(root, 'test', 'integration', 'setup', 'indexer-launcher.js'));
    const indexer = await launcher.initIndexer();
    try {
        const started = Date.now();
        const blocks = await launcher.processBlocks(indexer);
        const query = (sql, args) => indexer.indexerDb.doQuery(sql, args);
        const equivalence = require(path.join(root, 'test', 'integration', 'setup', 'equivalence.js'));
        const chain = await equivalence.readHashChain(query);
        const edits = await query('SELECT COUNT(*) AS n FROM lists WHERE list_action_index IS NOT NULL', []);
        const gate = require(path.join(root, 'src', 'protocol_changes.js')).copy(GATE);
        console.log(SIDE_MARK + JSON.stringify({ key, blocks, ms: Date.now() - started,
            edits: Number(edits[0].n), gate, chain }));
    } finally {
        await launcher.destroyIndexer(indexer);
    }
}

function runSideProcess(options, db, side, schema, state) {
    return new Promise((resolve) => {
        const logPath = path.join(state.workdir, side.key + '.log');
        const log = fs.createWriteStream(logPath);
        const child = spawn(process.execPath, [__filename, '--side'], {
            env: sideEnvironment(options, db, side.root, schema, side.key),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        state.children.add(child);
        let stdout = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; log.write(chunk); });
        child.stderr.on('data', (chunk) => log.write(chunk));
        child.on('close', (status, signal) => {
            state.children.delete(child);
            log.end();
            resolve({ status, signal, stdout, logPath });
        });
    });
}

function parseSideResult(result) {
    const line = result.stdout.split('\n').find((item) => item.startsWith(SIDE_MARK));
    return line ? JSON.parse(line.slice(SIDE_MARK.length)) : null;
}

async function dropScratchDatabases(options, db, schemas) {
    if (!schemas.length) return;
    const configModule = require(path.join(REPO, 'src', 'config.js'));
    const config = configModule.getConfig(options.coin, options.network);
    const Utility = require(path.join(REPO, 'src', 'utility.js'));
    const Database = require(path.join(REPO, 'src', 'db'));
    const indexer = { config, util: new Utility(config) };
    const handle = new Database(db.host, db.port, db.baseDb, db.user, db.pass, indexer);
    try {
        for (const schema of schemas) {
            if (!SCHEMA_NAME.test(schema)) throw new Error('invalid cleanup schema ' + JSON.stringify(schema));
            await handle.doQuery('DROP DATABASE IF EXISTS `' + schema + '`', []);
        }
    } finally {
        await handle.close();
    }
}

async function cleanupState(state, reason) {
    const closing = [];
    for (const child of state.children) {
        closing.push(new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const timeout = setTimeout(resolve, 5000);
            child.once('close', () => { clearTimeout(timeout); resolve(); });
            try { child.kill('SIGTERM'); } catch (_) { clearTimeout(timeout); resolve(); }
        }));
    }
    await Promise.all(closing);
    if (state.keep) {
        console.log('  ....  kept workdir ' + state.workdir + (state.schemas.length ? ' and schemas ' + state.schemas.join(', ') : ''));
        return;
    }
    if (state.db && state.schemas.length) {
        const dropSchemas = state.dropSchemas || dropScratchDatabases;
        await dropSchemas(state.options, state.db, state.schemas);
    }
    fs.rmSync(state.workdir, { recursive: true, force: true });
    if (reason) console.log('  ....  cleaned after ' + reason);
}

async function wait(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFileCorpus(options, gates) {
    const replay = readCorpusFile(options.corpusFile, options.network, Number(gates[options.network]));
    if (options.dryRun) throw new NamedRefusal('--dry-run validated the two-sided file but compared no hash chains');
    if (replay.holdMs > 0) {
        if (!Number.isSafeInteger(replay.holdMs) || replay.holdMs > 60000)
            throw new NamedRefusal('_hold_ms must be an integer from 1 through 60000');
        console.log('READY: holding the offline replay for ' + replay.holdMs + 'ms');
        await wait(replay.holdMs);
    }
    if (replay.legacy.length === 0) return { code: EXIT.VACUOUS, blocks: 0, divergence: null };
    const divergence = firstDivergence(replay.legacy, replay.off, replay.fields);
    return { code: divergence ? EXIT.FAIL : EXIT.PASS, blocks: replay.legacy.length,
             divergence, capture: replay.capture };
}

async function runDatabaseCorpus(options, state, gates) {
    state.db = projectDbConfig(options);
    const prefix = options.schemaPrefix || ('list_owner_replay_' + options.coin.toLowerCase());
    state.schemas = [prefix + '_legacy', prefix + '_off'];
    for (const schema of state.schemas)
        if (!SCHEMA_NAME.test(schema)) throw new NamedRefusal('derived scratch schema is not a plain name: ' + schema);
    await dropScratchDatabases(options, state.db, state.schemas);
    const trees = materializeTrees(state.workdir);
    if (options.dryRun) throw new NamedRefusal('--dry-run built and checked both trees but replayed no corpus');
    const sides = [
        { key: 'legacy', root: trees.legacyRoot },
        { key: 'off', root: trees.offRoot },
    ];
    const results = {};
    for (let i = 0; i < sides.length; i += 1) {
        const result = await runSideProcess(options, state.db, sides[i], state.schemas[i], state);
        const parsed = parseSideResult(result);
        if (result.status !== 0 || parsed === null)
            throw new NamedRefusal('side ' + sides[i].key + ' exited ' + result.status +
                ' without a result; see ' + result.logPath);
        results[sides[i].key] = parsed;
        if (Number(parsed.gate[options.network]) !== Number(gates[options.network]))
            throw new NamedRefusal('side ' + sides[i].key + ' resolved ' + options.network + ' activation ' +
                parsed.gate[options.network] + ', expected ' + gates[options.network]);
        console.log('  ....  ' + sides[i].key + ' replayed ' + parsed.blocks + ' blocks and ' + parsed.edits +
            ' LIST edits in ' + Math.round(parsed.ms / 1000) + 's');
    }
    const activationHeight = Number(gates[options.network]);
    for (const block of results.legacy.chain.concat(results.off.chain))
        if (block.block_index >= activationHeight)
            throw new NamedRefusal('replayed block ' + block.block_index + ' is not below activation height ' + activationHeight);
    if (results.legacy.chain.length === 0 || results.legacy.edits === 0)
        return { code: EXIT.VACUOUS, blocks: results.legacy.chain.length, edits: results.legacy.edits, divergence: null };
    const divergence = firstDivergence(results.legacy.chain, results.off.chain, HASH_FIELDS);
    return { code: divergence ? EXIT.FAIL : EXIT.PASS, blocks: results.legacy.chain.length,
             edits: results.legacy.edits, divergence };
}

async function runCli() {
    let options;
    try { options = parseArgs(process.argv.slice(2)); }
    catch (error) {
        console.error(error.message);
        return error.exitCode || EXIT.USAGE;
    }
    if (options.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        return EXIT.PASS;
    }
    const workdir = options.workdir ? path.resolve(options.workdir)
        : fs.mkdtempSync(path.join(os.tmpdir(), 'list-owner-witness-'));
    fs.mkdirSync(workdir, { recursive: true });
    const state = { options, workdir, keep: options.keep, db: null, schemas: [], children: new Set() };
    let reason = 'completion';
    activeCleanup = (signal) => cleanupState(state, signal);
    try {
        const gates = gateValues();
        console.log('# below-the-flag replay witness for ' + GATE);
        console.log('# gate mainnet=' + gates.mainnet + ' testnet=' + gates.testnet + ' regtest=' + gates.regtest);
        console.log('# chain ' + options.coin + '/' + (options.network || '(missing)') + ' corpus ' +
            (options.corpusFile || options.decoderDb || '(missing)'));
        validateOptions(options, gates);
        const result = options.corpusFile ? await runFileCorpus(options, gates) : await runDatabaseCorpus(options, state, gates);
        if (result.code === EXIT.PASS) {
            console.log('PASS: LEGACY and OFF are hash-identical across ' + result.blocks + ' below-the-flag blocks');
            if (result.capture) console.log('HISTORY: verified pinned indexer-history capture ' + result.capture.id);
            else if (options.corpusFile) console.log('SYNTHETIC: raw record corpus is not indexer-history evidence');
        } else if (result.code === EXIT.FAIL) {
            console.log('MISMATCH: first divergence at block ' + result.divergence.block + ' on ' + result.divergence.field +
                ': legacy=' + result.divergence.legacy + ' off=' + result.divergence.off);
        } else {
            console.log('VACUOUS: the corpus has no replayed LIST edits or no blocks, so it proves no LIST owner invariant');
        }
        return result.code;
    } catch (error) {
        reason = 'refusal';
        if (error instanceof NamedRefusal) {
            console.log('REFUSED: ' + error.message);
            return EXIT.REFUSED;
        }
        throw error;
    } finally {
        if (!signalInProgress) await cleanupState(state, reason);
        activeCleanup = null;
    }
}

module.exports = {
    EXIT, GATE, HASH_FIELDS, RESOLVED_CORPUS_FORMAT, TRUSTED_HISTORY_CAPTURES,
    parseArgs, gateValues, validateOptions, canonicalJson, buildHashChain, resolvedHashChain,
    historyCaptureDigest, validateHistoryCapture, firstDivergence, readCorpusFile,
    rollBackListOwner, cleanupState,
};
