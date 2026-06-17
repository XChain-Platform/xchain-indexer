# Security Policy

`xchain-indexer` is the core ledger engine of the XChain Platform. It reads decoded blockchain transactions, applies ACTION logic, and writes authoritative consensus state to MariaDB. Every validator in the network must reach byte-identical state, so determinism and correctness are paramount. A divergence, a balance forgery, or a reorg-handling flaw here propagates silently across the entire fleet, making this one of the highest-severity surfaces in the platform alongside xchain-vm. We treat reports seriously and respond fast.

If you've found a security issue, please **do not open a public issue or pull request**. Use the private channels below.

---

## How to report

### Preferred: GitHub Private Vulnerability Reporting

Open a draft advisory at:

<https://github.com/XChain-platform/xchain-indexer/security/advisories/new>

This is the fastest path. The advisory is private until we publish it.

### Alternative: Email

Email **security@dankest.llc** with:

- A description of the issue and the threat it poses.
- Reproduction steps or a proof-of-concept (a crafted action sequence, block, or payload that triggers the bug).
- The affected version (see `CHANGELOG.md` and the version badge in `README.md`) and the network you tested against (mainnet / testnet / regtest, and which chain).
- Any patches or mitigations you'd like considered.

For sensitive reports, encrypt the email body to our PGP key. The fingerprint will be published alongside the first signed release artifact; until then, the email channel is acceptable for first contact and we will coordinate an encrypted exchange before you share proof-of-concept details.

We do not currently offer a paid bug bounty. We do offer public credit in release notes and the advisory itself, unless you prefer to remain anonymous.

---

## Response timeline

| Stage | Target |
|---|---|
| Initial acknowledgement | within 72 hours |
| Triage + severity assignment | within 7 days |
| Fix or mitigation in master | within 30 days for high/critical, 90 days for lower severities |
| Coordinated public disclosure | up to 90 days from initial report, or sooner if a fix has shipped and operators are protected |

If we cannot meet a timeline, we will tell you why and propose a new one. We will not silently let a report age.

---

## Scope

### In scope

- **Consensus determinism:** any path in `src/actions/` that calls wall-clock time (`Date.now()`, `new Date()`, or similar) instead of the deterministic block timestamp; locale-dependent formatting; or any other nondeterminism that would cause two correct validator instances to reach different state. The `check:consensus-time` guard (`npm run check:consensus-time`) enforces this and must stay green.
- **Ledger-hash computation and tie-ordering:** the block ledger hash, actions hash, and contract hash that validators cross-check; any bug that lets two valid chains of blocks produce the same hash for different state, or different hashes for identical state.
- **Balance and fee math:** arithmetic using mathjs bignumber; any path that can result in a balance being credited without a corresponding debit, a fee being bypassed, or ownership being forged.
- **Reorg handling:** rollback correctness when the decoder signals a reorganization; any path where rolled-back state is not fully reverted or is inconsistently applied.
- **ACTION processing correctness:** any handler in `src/actions/` where a malformed or adversarially crafted action produces wrong ledger state rather than a clean rejection.
- **SQL construction and parameterization** against the MariaDB layer.
- **Denial-of-service** via crafted actions, blocks, or payloads that crash, hang, or exhaust resources in the indexer.

A divergence bug (two correct nodes reach different state) or a balance-forgery bug are critical severity.

### Out of scope

- Correctness of decoded input arriving from the decoder (that is the decoder's surface; report against `xchain-decoder` unless the root cause is indexer logic).
- The operator's own MariaDB configuration or network exposure.
- Bugs in downstream read APIs (`xchain-explorer`); report those against their own repository unless the root cause is indexer output.
- Vulnerabilities inside smart contracts executed by the VM (that is the contract author's issue, unless the indexer failed to sandbox or account for them correctly).

If you are unsure, send the report anyway and we will tell you whether it falls in scope.

---

## What we ask

- Give us a reasonable window to fix before disclosing publicly. The 90-day ceiling is firm; earlier is fine once a fix has shipped and operators are protected.
- Test against `regtest` or `testnet` where possible (the `xchain-regtest-miner` plus a local stack make this easy). Mainnet proofs-of-concept are accepted but should be the minimum needed.
- Do not run automated scanners against shared XChain infrastructure in a way that would impact availability for other operators.
- Do not access data, or attempt to access data, beyond what is needed to demonstrate the issue.

---

## What we will do

- Confirm receipt within the SLA above.
- Keep you informed as triage and remediation proceed.
- Credit you in the advisory and `CHANGELOG.md` entry, on request.
- Coordinate a CVE assignment when the severity warrants it.
- Publish a post-fix advisory describing the issue, the fix, and the affected version range.

---

## Versions covered

We ship security fixes against the latest release on `master`. Older releases are unsupported. The current version is recorded in `CHANGELOG.md` and the badge in `README.md`.

---

Last reviewed: 2026-06-16.
