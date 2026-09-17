'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const witness = require('../../../bin/verify-mirror-admission-replay-equivalence.js');

const TOOL = path.resolve(__dirname, '../../../bin/verify-mirror-admission-replay-equivalence.js');
const GATE = path.resolve(__dirname, '../../../src/consensus/gates/mirror_admission_gate.js');

const { queryIndexerDb } = witness;

// Runs fn with the given variables set on process.env the way child_process.spawn
// hands them to a child (an undefined value is dropped, anything else is stringified),
// then puts every touched variable back exactly as it was.
function withEnv(vars, fn) {
    const saved = {};
    for (const k of Object.keys(vars)) saved[k] = process.env[k];
    try {
        for (const [k, v] of Object.entries(vars)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = String(v);
        }
        return fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

describe('mirror-admission replay witness', function () {
    it('runs parameterized SQL through the indexer Database wrapper', async function () {
        const calls = [];
        const indexerDb = Object.create({
            async doQuery(sql, args) {
                calls.push({ sql, args });
                return [{ block_index: 7 }];
            },
        });
        const sql = 'SELECT block_index FROM blocks WHERE block_index = ?';
        const args = [7];

        const rows = await queryIndexerDb(indexerDb)(sql, args);

        assert.deepStrictEqual(rows, [{ block_index: 7 }]);
        assert.deepStrictEqual(calls, [{ sql, args }]);
        assert.strictEqual(indexerDb.query, undefined);
    });

    // The parent writes the lever through ARM_ENV in sideEnv() and the side process reads
    // it back by literal name in resolvedEra(), so the coverage gate can see the variable.
    // If the two names drift, every side resolves INERT and A3 refuses a real run; this
    // round trip catches it without a database. Each side runs in its own child process
    // spawned with sideEnv()'s env, as the tool does, because the gate snapshots its
    // regtest arming when it is first required.
    it('each side resolves, from the env the parent hands it, the era A3 expects', function () {
        this.timeout(20000);
        const o = witness.parseArgs(['--coin', 'BTC', '--network', 'regtest', '--activation-height', '120']);
        const p = { host: '127.0.0.1', port: '3306', user: 'replay', pass: 'unused' };
        const probe = 'const t = require(process.argv[1]); const g = require(process.argv[2]);' +
                      'process.stdout.write(JSON.stringify(t.resolvedEra(g)));';
        for (const side of Object.keys(witness.SIDES)) {
            const env = witness.sideEnv(o, p, side, 'ma_witness_replay_btc_' + side);
            const res = spawnSync(process.execPath, ['-e', probe, TOOL, GATE], { env, encoding: 'utf8' });
            assert.strictEqual(res.status, 0, side + ' probe exited ' + res.status + ': ' + res.stderr);
            const era = JSON.parse(res.stdout);
            const want = witness.eraExpectation(side, 120);
            assert.strictEqual(era.consumer, want.value, side + ' consumer activation');
            assert.strictEqual(era.producer, want.value, side + ' producer activation');
            // The armed sides must also REPORT the lever they were handed, which is the read
            // whose name the gate cannot see through ARM_ENV.
            if (witness.armValueFor(side, 120) !== null)
                assert.strictEqual(era.armEnv, witness.armValueFor(side, 120), side + ' reported lever');
        }
    });
});

describe('mirror-admission replay witness: what each side is handed and replays against', function () {
    // The rail's OFF side (2026-09-17) was handed the STRING "null": spawn stringifies a null
    // value, and the resolver read it as unrecognised (inert with a RegtestArmingWarning in
    // off.log) rather than as an unset lever. OFF must carry no key at all, including when the
    // operator's own shell has the lever armed.
    it('hands the OFF side no lever at all, even when the parent environment carries one', function () {
        this.timeout(20000);
        const o = witness.parseArgs(['--coin', 'BTC', '--network', 'regtest', '--activation-height', '120']);
        const p = { host: '127.0.0.1', port: '3306', user: 'replay', pass: 'unused' };
        const env = withEnv({ [witness.ARM_ENV]: 'armed' }, () => witness.sideEnv(o, p, 'off', 'ma_witness_replay_btc_off'));
        assert.ok(!Object.prototype.hasOwnProperty.call(env, witness.ARM_ENV),
            'OFF was handed ' + witness.ARM_ENV + '=' + JSON.stringify(env[witness.ARM_ENV]));
        const probe = 'const t = require(process.argv[1]); const g = require(process.argv[2]);' +
                      'process.stdout.write(JSON.stringify(t.resolvedEra(g)));';
        const res = spawnSync(process.execPath, ['-e', probe, TOOL, GATE], { env, encoding: 'utf8' });
        assert.strictEqual(res.status, 0, 'off probe exited ' + res.status + ': ' + res.stderr);
        assert.deepStrictEqual(JSON.parse(res.stdout), { armEnv: null, producer: null, consumer: null });
        assert.ok(!/RegtestArmingWarning|ignoring/.test(res.stderr), 'the OFF side still reached the unrecognised-value path: ' + res.stderr);
        // The armed sides still override an inherited value with their own.
        const on = withEnv({ [witness.ARM_ENV]: 'armed' }, () => witness.sideEnv(o, p, 'boundary', 'x'));
        assert.strictEqual(on[witness.ARM_ENV], '120');
    });

    it('passes the mirror schema to each side on argv, and a side accepts only a plain schema name', function () {
        const o = witness.parseArgs(['--mirror-db', 'XChain_AM_bf8_Mirror0']);
        const args = witness.sideArgs(o);
        assert.deepStrictEqual(args.slice(1), ['--side', '--mirror-db', 'XChain_AM_bf8_Mirror0']);
        assert.strictEqual(witness.sideMirrorDb(args), 'XChain_AM_bf8_Mirror0');
        assert.strictEqual(witness.sideMirrorDb(['node', 'tool', '--side']), null);
        assert.strictEqual(witness.sideMirrorDb(['--side', '--mirror-db', 'x`; DROP TABLE blocks; --']), null);
    });

    it('binds by this chain\'s admission column only in the tables a consumer reads by it', function () {
        assert.deepStrictEqual(witness.admissionColumnsFor('BTC'), {
            cross_chain_matches: 'admit_block_btc', cross_chain_calls: 'admit_block_btc', bridge_transfers: 'admit_block_btc',
            policy_snapshots: 'admit_block_btc', attestation_responses: 'admit_block_btc',
        });
        assert.ok(!('attestation_responses' in witness.admissionColumnsFor('LTC')), 'the attest rail is BTC-only');
        assert.strictEqual(witness.admissionColumnsFor('LTC').cross_chain_calls, 'admit_block_ltc');
        assert.deepStrictEqual(witness.admissionColumnsFor('b`tc'), {});
    });
});

describe('mirror-admission replay witness: the mirror a side copies', function () {
    it('copies every hub-mirror table over the shared columns before counting admission-era rows', async function () {
        const mirror = {
            cross_chain_calls: { cols: ['id', 'call_id', 'admit_block_btc'], rows: 3, admitted: 2 },
            attestation_responses: { cols: ['id', 'request_id', 'admit_block_btc'], rows: 1, admitted: 0 },
        };
        const sql = [];
        const q = async (text, args) => {
            sql.push(text);
            if (/JOIN information_schema/.test(text)) return (mirror[args[1]] ? mirror[args[1]].cols : []).map((c) => ({ c }));
            const count = /FROM `([a-z_]+)`( WHERE `admit_block_btc` IS NOT NULL)?$/.exec(text);
            if (/^SELECT COUNT\(\*\) AS n FROM information_schema/.test(text)) return [{ n: mirror[args[0]] && mirror[args[0]].cols.includes(args[1]) ? 1 : 0 }];
            if (count) return [{ n: count[2] ? mirror[count[1]].admitted : mirror[count[1]].rows }];
            return [];
        };
        const got = await witness.loadMirror(q, 'mirror_src', 'BTC');
        assert.strictEqual(got.source, 'mirror_src');
        assert.strictEqual(got.copied.cross_chain_calls, 3);
        assert.strictEqual(got.copied.cross_chain_matches, null, 'a table the mirror lacks is named, not skipped silently');
        assert.ok('state_checkpoints' in got.copied && 'price_snapshots' in got.copied, 'the copy set is the registry\'s hub-mirror tables');
        assert.deepStrictEqual(got.admissionRows, {
            cross_chain_matches: 0, cross_chain_calls: 2, bridge_transfers: 0, policy_snapshots: 0, attestation_responses: 0,
        });
        assert.ok(sql.includes('INSERT INTO `cross_chain_calls` (`id`, `call_id`, `admit_block_btc`) SELECT `id`, `call_id`, `admit_block_btc` FROM `mirror_src`.`cross_chain_calls`'),
            'the copy is one INSERT ... SELECT over the shared columns: ' + JSON.stringify(sql.filter((s) => /^INSERT/.test(s))));
    });
});

describe('mirror-admission replay witness: a vacuous corpus is a named refusal, not a verdict', function () {
    const O = { coin: 'BTC', activationHeight: 60 };
    const chain = (n) => Array.from({ length: n }, (_, i) => ({ block_index: i + 1 }));
    const mirror = (admitted) => ({ source: 'm', copied: { cross_chain_calls: 3 }, admissionRows: { cross_chain_calls: admitted } });
    const sides = (m, n) => ({ off: { mirror: m, chain: chain(n) }, boundary: { mirror: m, chain: chain(n) }, on: { mirror: m, chain: chain(n) } });

    it('accepts a mirror with admission-era rows and a boundary inside the corpus', function () {
        assert.strictEqual(witness.corpusRefusal(O, sides(mirror(2), 102)), null);
    });

    it('refuses the rail\'s run: sides replayed with empty mirror tables', function () {
        assert.match(witness.corpusRefusal(O, sides(null, 102)), /side off replayed without a hub mirror/);
    });

    it('refuses a mirror with no row carrying this chain\'s admission height', function () {
        assert.match(witness.corpusRefusal(O, sides(mirror(0), 102)), /^no row arming would change: mirror m holds no row with BTC's admission height/);
    });

    it('refuses a boundary above the corpus tip, the rail\'s H=100000 over 102 blocks', function () {
        assert.match(witness.corpusRefusal({ coin: 'BTC', activationHeight: 100000 }, sides(mirror(2), 102)),
            /boundary height 100000 is above the corpus tip 102/);
        assert.strictEqual(witness.corpusRefusal({ coin: 'BTC', activationHeight: 102 }, sides(mirror(2), 102)), null, 'H at the tip is inside');
    });

    it('refuses sides that copied different mirrors', function () {
        const r = sides(mirror(2), 102);
        r.on = { mirror: mirror(1), chain: chain(102) };
        assert.match(witness.corpusRefusal(O, r), /copied different mirrors/);
    });

    it('refuses on the command line, before any replay, when no --mirror-db is named', function () {
        this.timeout(20000);
        const res = spawnSync(process.execPath, [TOOL, '--coin', 'BTC', '--network', 'regtest', '--decoder-db', 'dec',
            '--activation-height', '60', '--db-host', '127.0.0.1', '--db-port', '1', '--db-user', 'u', '--db-pass-env', 'MA_WITNESS_UNIT_PASS'],
            { env: Object.assign({}, process.env, { MA_WITNESS_UNIT_PASS: 'x' }), encoding: 'utf8' });
        assert.strictEqual(res.status, witness.EXIT.REFUSED, res.stdout + res.stderr);
        const last = res.stdout.trim().split('\n').pop();
        assert.match(last, /^REFUSED: --mirror-db <schema> is required/);
        assert.ok(!/== replay/.test(res.stdout), 'it replayed before refusing');
    });

    it('reads the password from the variable --db-pass-env names, and refuses when it is unset', function () {
        const o = witness.parseArgs(['--db-host', '127.0.0.1', '--db-port', '3306', '--db-user', 'replay',
                                     '--db-pass-env', 'MA_WITNESS_UNIT_PASS']);
        const set = withEnv({ MA_WITNESS_UNIT_PASS: 'from-the-named-variable', TEST_DB_PASS: 'wrong-source' },
                            () => witness.explicitDbParams(o));
        assert.deepStrictEqual(set, { host: '127.0.0.1', port: '3306', user: 'replay', pass: 'from-the-named-variable' });
        const unset = withEnv({ MA_WITNESS_UNIT_PASS: undefined, TEST_DB_PASS: 'wrong-source' },
                              () => witness.explicitDbParams(o));
        assert.deepStrictEqual(unset, { missingPassEnv: 'MA_WITNESS_UNIT_PASS' });
    });
});
