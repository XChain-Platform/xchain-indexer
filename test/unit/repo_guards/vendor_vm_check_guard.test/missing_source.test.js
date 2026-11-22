'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', '..', '..', 'bin', 'vendor-vm.sh');

function fixture(copyPresent){
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indexer-vm-check-'));
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(root, 'bin', 'vendor-vm.sh'));
    const dest = path.join(root, 'xchain-vm');
    if(copyPresent){
        fs.mkdirSync(path.join(dest, 'src'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'src', 'marker.js'), 'unchanged\n');
    }
    return { root, dest };
}

function runCheck(item, overrides = {}){
    const env = Object.assign({}, process.env);
    delete env.XCHAIN_REQUIRE_SIBLINGS;
    delete env.XCHAIN_VM_ALLOW_UNVERIFIED;
    return spawnSync('bash', [path.join(item.root, 'bin', 'vendor-vm.sh'), 'check'], {
        encoding: 'utf8',
        env: Object.assign(env, {
            XCHAIN_VM_SOURCE: path.join(item.root, 'missing-vm')
        }, overrides)
    });
}

describe('vendored VM missing-source verification @regression @tier1', function () {
    it('fails without modifying a present vendored copy', function () {
        const item = fixture(true);
        const run = runCheck(item);

        assert.notStrictEqual(run.status, 0);
        assert.match(`${run.stdout}${run.stderr}`, /UNVERIFIED/);
        assert.strictEqual(fs.readFileSync(path.join(item.dest, 'src', 'marker.js'), 'utf8'), 'unchanged\n');
    });

    it('passes when neither canonical source nor vendored copy exists', function () {
        const item = fixture(false);
        const run = runCheck(item);

        assert.strictEqual(run.status, 0, run.stderr);
        assert.strictEqual(fs.existsSync(item.dest), false);
    });

    it('requires an explicit opt-out to accept a present unverified copy', function () {
        const item = fixture(true);
        const run = runCheck(item, { XCHAIN_VM_ALLOW_UNVERIFIED: '1' });

        assert.strictEqual(run.status, 0, run.stderr);
        assert.match(`${run.stdout}${run.stderr}`, /UNVERIFIED/);
    });

    it('does not let the opt-out weaken strict mode', function () {
        const item = fixture(true);
        const run = runCheck(item, {
            XCHAIN_VM_ALLOW_UNVERIFIED: '1',
            XCHAIN_REQUIRE_SIBLINGS: '1'
        });

        assert.notStrictEqual(run.status, 0);
        assert.match(`${run.stdout}${run.stderr}`, /refusing to skip/);
    });
});
