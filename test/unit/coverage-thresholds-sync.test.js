const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The coverage ratchet keeps its floors in two places: bin/coverage-thresholds.json,
// which is what a human reads, and the c8 flags inside the coverage:check npm script,
// which is what CI obeys. Every one of those files says "keep both in sync" and
// nothing enforced it, so a floor could describe a ratchet the job was not running.
// The failure mode is not hypothetical: xchain-dashboard's ci.yml called a
// coverage:check script that did not exist in that repo at all, a job that could only
// ever exit 1, and the missing-script case is asserted here for that reason.
describe('coverage ratchet floors', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const declared = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'bin', 'coverage-thresholds.json'), 'utf8'),
  );

  it('ships the coverage:check script the CI coverage job invokes', () => {
    assert.equal(
      typeof (pkg.scripts || {})['coverage:check'],
      'string',
      'ci.yml runs `npm run coverage:check`; without the script the job can only exit 1',
    );
  });

  it('enforces every declared floor, at the declared value', () => {
    const script = pkg.scripts['coverage:check'];
    for (const metric of ['lines', 'statements', 'branches', 'functions']) {
      const flag = script.match(new RegExp('--' + metric + '\\s+([0-9.]+)'));
      assert.ok(flag, `coverage:check does not enforce --${metric}, so that floor is decorative`);
      assert.equal(
        Number(flag[1]),
        declared[metric],
        `${metric} floor drifted: thresholds.json says ${declared[metric]}, coverage:check enforces ${flag[1]}`,
      );
    }
  });

  it('fails the job on a shortfall rather than only reporting it', () => {
    assert.match(pkg.scripts['coverage:check'], /--check-coverage/);
  });
});
