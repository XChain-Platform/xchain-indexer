# Contributing to XChain Indexer

Thanks for considering a contribution. `xchain-indexer` is the core ledger engine: it applies ACTION logic and maintains authoritative consensus state, so every validator in the network must reach byte-identical output. We trade speed for correctness on every commit.

If you're reporting a security issue, **stop here** and read [`SECURITY.md`](./SECURITY.md) instead. Security reports go through a private channel.

---

## Quick links

- Project overview: [`README.md`](./README.md)
- Full component docs: the [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation/tree/master/indexer) repository (architecture, configuration, database schema, operations)
- Disclosure policy: [`SECURITY.md`](./SECURITY.md)
- License: [`LICENSE.md`](./LICENSE.md) + [`NOTICE.md`](./NOTICE.md) (GNU Affero General Public License v3.0, dual-licensed)

---

## Repo layout in 30 seconds

```
xchain-indexer/
├── src/                  indexer pipeline: action handlers, ledger, hash engine, DB writes, API
│   └── sql/migrations/   runner-tracked migrations (auto-applied at boot; see migrations/README below)
├── test/                 layered suites (unit, integration, e2e, fuzz, chaos, mutation, security, ...)
├── migrations/           LEGACY manual runbook SQL - NOT auto-applied (see migrations/README.md)
├── CHANGELOG.md          authoritative version history
├── SECURITY.md           private vulnerability disclosure
└── package.json          scripts + dependencies
```

---

## Setting up

### Prerequisites

- **Node.js 22 exactly.** The platform pins Node 22 fleet-wide: the `mariadb` driver is ESM-only (Node 18 fails with `ERR_REQUIRE_ESM`), and newer majors are not validated against the stack. `engines.node` declares `>=22.0.0`; use 22.
- **MariaDB** reachable from the indexer host for anything beyond unit tests.
- A running `xchain-decoder` instance (or its database snapshot) feeding decoded transaction data for integration and e2e runs. For local work, the `xchain-regtest-miner` plus a regtest stack is the easiest path.

### First-time install

```bash
git clone https://github.com/XChain-platform/xchain-indexer.git
cd xchain-indexer
npm install
```

Create a `.env` (see [`README.md`](./README.md) for the full key list). **Never commit a `.env` or any real credential.** Secrets live only in the local `.env`, loaded at runtime; never hard-code them into source, tests, or scripts.

---

## Running it

```bash
npm run api        # start the indexer and API server
npm run migrate    # apply database migrations
```

---

## Tests

The indexer runs a layered suite. Pick the tier that matches your change:

| Tier | Command | Needs external services |
|---|---|---|
| Smoke | `npm run test:smoke` | No |
| Unit | `npm test` | No |
| Security | `npm run test:security` | No |
| CI (unit, fast gate) | `npm run ci` | No |
| Consensus-time guard | `npm run check:consensus-time` | No |
| Boundary | `npm run test:boundary` | No |
| Fuzz | `npm run test:fuzz` (`:quick` for 1,000 iterations) | No |
| Chaos | `npm run test:chaos` | No |
| Mutation | `npm run test:mutation` | No |
| Integration | `npm run test:integration` | MariaDB + decoder DB |
| End-to-end | `npm run test:e2e` | Full stack |

Run the no-external-services tiers before every commit (`npm run check:consensus-time && npm run ci && npm run test:security`). New action handlers or ledger logic should come with fuzz and security coverage. Changes to `src/actions/` must keep `npm run check:consensus-time` green: wall-clock time (`Date.now()`, `new Date()`) must never be called inside action handlers; use the deterministic block timestamp (`data["BLOCK_TIME"]`) instead. A violation here diverges consensus state across validator instances.

---

## Coding style

- **Plain JavaScript**, no TypeScript. Raw parameterized SQL via the `mariadb` driver, no ORM.
- **No linter is configured.** Match the style of the surrounding file: naming, structure, and comment density.
- **Comments are rare on purpose.** Don't restate what well-named code already says. Do comment a *why* that isn't obvious: a hidden invariant, a consensus-relevant constraint, a workaround with a reference.
- **Never use the em-dash character** in code, comments, or docs. Rewrite the sentence (a comma, colon, or parentheses) instead.
- **Two trailing spaces** on consecutive bold-label markdown lines so CommonMark renders the line break instead of collapsing them.
- **Determinism is non-negotiable.** Every validator must reach byte-identical state. Avoid wall-clock time, locale-dependent formatting, or any other nondeterminism in `src/actions/` or the ledger-hash path. The `check:consensus-time` guard is a hard CI gate.

---

## Commit messages

Match the existing log style: a concise subject line, then a short body explaining what changed and why.

- Branch off `master` and keep history linear (rebase, don't merge).
- One logical change per commit; don't batch unrelated work.
- **No `Co-Authored-By` trailers.** This is a project policy.
- **Never `--no-verify`.** If a hook fails, fix the cause; don't bypass it.

---

## Pull requests

CI is the smoke + unit gate. Before opening a PR:

1. Run `npm run check:consensus-time` and confirm it passes.
2. Run the no-external-services tiers (`npm run ci`, `npm run test:security`) and confirm they pass.
3. Update `CHANGELOG.md` with a terse entry for your change.
4. Make sure `git status` is clean apart from intended changes (no `node_modules/`, no editor leftovers, no `.env`).
5. Open the PR with a clear title and a description of what changed and why.

For non-security bugs, open an issue at <https://github.com/XChain-platform/xchain-indexer/issues/new>. For security bugs, see [`SECURITY.md`](./SECURITY.md).

---

Last reviewed: 2026-06-16.
