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
