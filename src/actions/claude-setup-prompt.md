# Set up my pre-push CI gate (from claude-bin-main.zip)

You are installing a CI gate so that every `git push` is blocked until the test
suite passes on a remote Linux test host ("venue"), run against the EXACT commit
being pushed (never the working tree). From now on, when I say "push": commit if
needed, then `git push`. The pre-push hook dispatches the suite to a venue. If the
gate fails, read its output, fix the problem, commit, and push again. Iterate
until the gate reports GREEN and the push lands.

## How it works (3 scripts + 1 hook per repo)

- `ci-dispatch.sh` (runs on my dev machine, called by the pre-push hook): picks a
  free venue from a pool (venues are claimed with flock, one gate per venue;
  busy venues queue), pushes the exact commit to a bare repo on the venue, then
  runs ci-gate.sh there over ssh.
- `ci-gate.sh` (auto-deployed to the venue by the dispatcher on every run; never
  invoked by hand): checks the commit out on the venue's LOCAL disk, installs
  deps via `npm ci` (cached, keyed on the lockfile hash), optionally provisions
  throwaway per-run databases, runs the test command, and classifies any failure
  as COMMIT (tests ran and failed), VENUE (exit 95, the machine is broken, the
  commit was never evaluated), or NORUN (exit 94, died before the first test,
  cause unattributable).
- `pick-host.sh`: standalone least-loaded-host picker for ad-hoc heavy jobs. NOT
  used by the push gate (the dispatcher has its own venue table). Optional.
- `bin/hooks/pre-push` (one per repo, template below): forwards to the dispatcher.

## Step 1: install the scripts

Unzip claude-bin-main.zip and put `ci-dispatch.sh`, `ci-gate.sh`, `pick-host.sh`
in `~/.claude/bin/`, then `chmod +x` all three. The hook hard-codes
`$HOME/.claude/bin/ci-dispatch.sh`, and the dispatcher hard-codes
`$HOME/.claude/bin/ci-gate.sh`, so the location matters.

## Step 2: configure the venue pool

Ask me which Linux host(s) I want as test venues, then edit the `VENUES=` line in
`ci-dispatch.sh` (format: space-separated `host:ci_root` pairs, preference order,
e.g. `VENUES="${CI_VENUES:-mybox:/home/me/ci}"`). Each venue needs:
- ssh key auth from this machine (the dispatcher uses `BatchMode=yes`; a password
  prompt = venue skipped as unreachable). Test: `ssh -o BatchMode=yes <host> true`
- git, rsync, flock, timeout (standard on Linux), and Node 22+ on the venue
  (nvm is fine; the gate sources `~/.nvm/nvm.sh` and runs `nvm use 22` if present)
- the ci_root directory just needs to be creatable; the dispatcher makes the
  layout (`bin/ repos/ work/ logs/ cache/ sidecars/`) itself
If you edit pick-host.sh too, update its `RUNNERS=` line the same way (optional).

## Step 3: databases (only if the test suite uses one)

If a repo's suite needs MySQL/MariaDB, the gate detects it from the repo's
committed `.env.example` (or `config/.env.example`): any `<PREFIX>DB_NAME=` var
means "render a .env with a throwaway per-run schema". For that to work, on each
venue: install MariaDB, create a CI db user with CREATE/DROP rights, and write
`<ci_root>/venue.env` (chmod 600, on the venue only, NEVER in git) containing:
CI_DB_HOST, CI_DB_PORT, CI_DB_USER, CI_DB_PASS. The gate creates schemas named
`ci_<repo>_..._<sha>_<pid>`, points the rendered .env at them, and drops them
after the run. Suites with no DB vars skip all of this.

## Step 4: install the hook in each repo

Create `bin/hooks/pre-push` in the repo (commit it), `chmod +x` it, and run
`git config core.hooksPath bin/hooks` in each clone (relative path, so it works
on any machine the repo is cloned to). Template:

```sh
#!/bin/sh
# pre-push: gate the push on a green CI run of the COMMIT BEING PUSHED.
# Install (per clone): git config core.hooksPath bin/hooks
# Deliberate bypass:   PREPUSH_SKIP=1 git push

if [ -n "$PREPUSH_SKIP" ]; then
    echo "pre-push: PREPUSH_SKIP set, SKIPPING the CI gate (you own the risk)" >&2
    exit 0
fi

DISPATCH="$HOME/.claude/bin/ci-dispatch.sh"
if [ ! -x "$DISPATCH" ]; then
    echo "pre-push: ERROR ci-dispatch.sh not found at $DISPATCH; push blocked." >&2
    exit 2
fi

# stdin (git's ref list) is forwarded, so the dispatcher tests exactly the
# commit git is about to send. Set --repo and --cmd per repo.
exec "$DISPATCH" \
    --repo my-repo-name \
    --src "$(git rev-parse --show-toplevel)" \
    --cmd "npm test"
```

`--repo` names the bare repo / cache / logs on the venue (unique per repo).
`--cmd` is the full gate command; chain whatever this repo considers CI, e.g.
`"npm run lint && npm test"`.

## Optional per-repo declaration files (committed at repo root)

- `.ci-sidecars`: paths (one per line) to gitignored files the suite genuinely
  needs (e.g. dev signing certs). Rsynced to the venue and restored into the
  checkout after cleaning.
- `.ci-siblings`: sibling repos the suite resolves at `../<name>` (checked out
  adjacent on the venue, source-only, deps installed with npm ci --ignore-scripts).
- `.ci-siblings-nested`: sub-repos living INSIDE this repo's tree (each gets a
  full npm install, in listed order, so `file:` deps resolve).
- `.ci-databases`: extra database names the tests hard-code for themselves.
  Prefer the `dbname=ENV_VAR` form (per-run isolated db, name exported via that
  env var) over a bare name (shared literal db).
Skip all four unless the suite needs them.

## Rules for you (Claude) from now on

1. When I say "push": fetch and rebase on origin first, then `git push`, and let
   the hook run. Never bypass it.
2. Gate FAILED with a test tally: the commit is at fault. Read the failing tests
   in the output (full log path is printed, on the venue), fix, commit, push again.
3. Exit 95 (VENUE banner): the machine is broken, my commit was never evaluated.
   Fix the venue (the banner names the cause), don't touch the commit, don't retry
   blindly, and do NOT use PREPUSH_SKIP.
4. Exit 94 (NEVER RAN banner): died at load; could be commit or venue. Run the
   same command locally; green locally means suspect the venue.
5. "All venues busy" queues up to 7 minutes then blocks; just push again later,
   or pin a venue with `CI_VENUES="host:/ci/root" git push`.
6. `PREPUSH_SKIP=1 git push` exists but is mine to authorize, never yours to
   decide. Ask me first, every time.
7. Add a short note about this workflow (what "push" means, the exit-code rules
   above) to my CLAUDE.md so it survives future sessions.

Verify the setup end to end with a trivial commit on a branch: the push should
print "CI gate for <repo> @ <sha>", run the suite on the venue, and end with
"CI gate GREEN on <host>; pushing."
