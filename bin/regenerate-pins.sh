#!/usr/bin/env bash
#*********************************************************************
#
# Copyright © 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
#*********************************************************************
#
# Regenerate this repository's generated pins from the tree: the pins the
# platform's generated-pins list names for it. On an unchanged tree it writes
# nothing.
#
#   bin/regenerate-pins.sh                  every pin below
#   bin/regenerate-pins.sh suite-titles     bin/pins/at1-suite-titles.json
#   bin/regenerate-pins.sh identity         bin/pins/at1-consensus-identity.json
#   bin/regenerate-pins.sh carrier-logic    bin/pins/carrier-logic.json (checked, never rewritten)
#
# THE SUITE TITLES need XCHAIN_DOCS_DIR pointed at a snapshot of the
# documentation repo, the way the suite-title tier of bin/ci-full.sh takes one:
# test files that read documentation fixtures declare titles from them, so a
# half-edited sibling checkout would leak titles into the pin.
#
# THE CARRIER LOGIC PIN has no regenerate, by design: an entry moves only
# through `bin/lib/carrier_logic_pin.js --write --id <id> --reason "<text>"`,
# which records the re-pin, and its unit test refuses an entry that moved
# without that record. So this script checks it and fails if it does not hold.
# It runs before the identity pin, whose carrier_logic_digest is read from it.

set -u
cd "$(dirname "$0")/.." || exit 2

suite_titles() {
  if [ -z "${XCHAIN_DOCS_DIR:-}" ]; then
    echo "regenerate-pins: suite-titles needs XCHAIN_DOCS_DIR set to a documentation snapshot" >&2
    return 2
  fi
  # Taken on a copy and moved into place only on a clean run: a dry run that
  # fails to load a test file still writes its map, with the script emptied.
  local fresh="bin/pins/.at1-suite-titles.json.new" status
  cp bin/pins/at1-suite-titles.json "$fresh" || return 2
  node bin/suite-title-map.js --script test --out "$fresh" >&2
  status=$?
  if [ "$status" -ne 0 ]; then rm -f bin/pins/.at1-suite-titles.json.new; return "$status"; fi
  if cmp -s "$fresh" bin/pins/at1-suite-titles.json; then rm -f bin/pins/.at1-suite-titles.json.new; return 0; fi
  mv "$fresh" bin/pins/at1-suite-titles.json
}

carrier_logic() { node bin/lib/carrier_logic_pin.js >/dev/null; }

identity() { node bin/regenerate-identity-pin.js; }

[ "$#" -gt 0 ] || set -- suite-titles carrier-logic identity
rc=0
for pin in "$@"; do
  case "$pin" in
    suite-titles)  suite_titles ;;
    carrier-logic) carrier_logic ;;
    identity)      identity ;;
    *) echo "regenerate-pins: unknown pin: $pin" >&2; exit 2 ;;
  esac
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "regenerate-pins: $pin failed (exit $status)" >&2
    rc=1
  fi
done
exit "$rc"
