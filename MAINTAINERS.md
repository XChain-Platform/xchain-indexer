# Maintainers

This file lists the people responsible for `xchain-indexer`, what each of them owns, and how to escalate issues that need a human's attention beyond what `CONTRIBUTING.md` and `SECURITY.md` cover.

The XChain Platform is in pre-launch development and ships under a single primary maintainer today. As contributors take on durable responsibility for areas of the codebase, they will be added here. This is a conventional MAINTAINERS file (an open-source norm used by distros and downstream packagers), not an aspirational org chart.

---

## Primary maintainer

| Role | Name | GitHub | Areas |
|---|---|---|---|
| Lead | J-Dog | [@J-Dog](https://github.com/J-Dog) | Everything: action processing, ledger state, balance and fee math, reorg handling, per-chain configs, API, releases |

Contact:

- General and non-sensitive: open an issue at <https://github.com/XChain-platform/xchain-indexer/issues>.
- Code of Conduct: `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`).
- Security disclosures: GitHub Private Vulnerability Reporting, or `security@dankest.llc` (per `SECURITY.md`).

---

## Areas of responsibility

Until additional maintainers join, the lead owns every area below. The table is here so a future contributor (or downstream packager) can see what each area entails when scoping a contribution.

| Area | What it covers |
|---|---|
| ACTION processing | All action handlers under `src/actions/` (SEND, ISSUE, MINT, ORDER, DEPLOY, EXECUTE, STAKE, XCALL, and the full set); the dispatch layer in `src/actions.js` |
| Ledger state and hash | Ledger-hash computation, tie-ordering, three per-block hashes (ledger, actions, contract); the double-entry credit/debit/escrow accounting; `src/stateHash.js` |
| Balance and fee math | All amount and fee arithmetic via mathjs bignumber; unified gas fee schedule; supply sanity checks; `src/utility.js` |
| Reorg handling | Block reorganization detection against the decoder DB, rollback logic, atomic block transactions; `src/rollback.js` and `src/recovery.js` |
| Per-chain configs and migrations | Chain-specific constants and activation heights (`src/configs/BTC.js`, `DOGE.js`, `LTC.js`); schema migrations under `migrations/`; `src/protocol_changes.js` |
| Hub integration | Hub-facing RPCs, capability snapshot pushes, validator-reward ingestion; `src/hub_client.js`, `src/hub_push_queue.js`, `src/hub_db_sync.js` |
| VM integration | Handoff to xchain-vm for DEPLOY/EXECUTE/XCALL/XEXEC; the `xchain-vm` subtree; contract and emit-call surface |
| Attestation | External attestation request lifecycle, PBFT quorum callback wiring; `src/attestation/` and `src/equivocation_header.js` |
| API | The indexer HTTP API (`src/api.js`) |
| Tests | The layered suites under `test/` (unit, integration, e2e, fuzz, chaos, mutation, boundary, smoke, performance, regression) |
| Documentation | `README`, `SECURITY`, `CODE_OF_CONDUCT`, `CONTRIBUTING`, `MAINTAINERS`, `CHANGELOG` |

---

## Adding a maintainer

A contributor becomes a maintainer when they have:

1. Sustained contribution in a specific area for at least one release cycle (typically 2 to 3 weeks of active work).
2. Reviewed and merged at least three PRs from outside contributors.
3. Demonstrated awareness of the project's conventions: no wall-clock time in `src/actions/` (enforced by the `check:consensus-time` guard), deterministic math using mathjs bignumber for all amounts and fees, raw parameterized SQL with no ORM, the `Keep a Changelog` format, and Node 22 as the pinned runtime.

Open a PR adding the new maintainer to the table above with their GitHub handle and area(s) of responsibility. The lead approves and merges.

## Removing a maintainer

A maintainer steps down by opening a PR removing their row. The lead also removes a maintainer who has been inactive for six months or who violates the Code of Conduct, after a written notice period.

---

## Escalation paths

If you cannot reach the relevant area maintainer within a reasonable window:

| Situation | Escalate to |
|---|---|
| Active security incident | `security@dankest.llc` (per `SECURITY.md`) |
| A consensus divergence, balance forgery, or reorg-handling defect | Open a public issue tagged `consensus` AND email `security@dankest.llc` |
| Code-of-conduct concern | `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`) |
| PR has been open without review for 14+ days | Comment `@J-Dog` on the PR; if no response within 7 more days, open an issue tagged `governance` with the PR link |

---

## Decision-making

The lead makes final calls on:

- Any consensus-affecting logic: action handler behavior, ledger-hash computation, tie-ordering, fee schedules, and protocol activation heights.
- Database schema and migration changes.
- Determinism guarantees and the constraint that no wall-clock time may enter `src/actions/`.
- Release timing and version policy.
- Adopting a new heavy dependency.
- Code-of-conduct enforcement, and maintainer additions or removals.

Smaller calls (bug fixes, additions within an existing area, documentation, dependency bumps inside an existing minor) go through PR review by the area maintainer.

---

## Cross-project relationships

| Project | Relationship |
|---|---|
| [`xchain-decoder`](https://github.com/XChain-platform/xchain-decoder) | The indexer reads the decoder database; the decoder's output is the indexer's input |
| [`xchain-explorer`](https://github.com/XChain-platform/xchain-explorer) | Reads the indexer database for the REST API, JSON-RPC, and web UI |
| [`xchain-hub`](https://github.com/XChain-platform/xchain-hub) | The indexer pushes capability snapshots and price data; the hub feeds oracle prices back |
| [`xchain-vm`](https://github.com/XChain-platform/xchain-vm) | Invoked by the indexer for DEPLOY, EXECUTE, XCALL, and XEXEC action processing |
| [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation) | Protocol spec: ACTION definitions, encoding formats, database naming, ledger rules |

The indexer maintainer is not automatically a maintainer of those sibling projects. Cross-project changes go through each project's own review process.
