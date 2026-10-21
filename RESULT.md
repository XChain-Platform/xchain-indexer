# Lane report: cx-xc-6009-p1

## Files touched (versus the merge-base with origin/develop)
- test/unit/anchor/archive_head_v1_reissue_below_gate.test.js (new, unchanged from the earlier rounds)
- bin/pins/at1-suite-titles.json

## What changed this round
The review failure was right: the pin carried in the earlier round had been regenerated wholesale in a checkout
without the sibling xchain-vm package, so it shifted unrelated title sets, file counts and hashes.
I merged origin/develop, took develop's pin as is, and added only this row's entry by hand:
- one title set, 47fe733ee948f0cb, holding the 2 titles of the new test
- that file registered in the scripts that collect it: test, test:regression, test:regression:full
- fileCount +1 and titleCount +2 for those three scripts only
The diff of the pin against origin/develop is 13 insertions and 6 deletions, all of them these lines.

## Tests
- mocha on the new test plus archive_reissue_guard, anchor_v3_same_publisher_reissue and
  anchor_v3_fold_reissue_source_author: 16 passing, 0 failing.
- Surface check: the diff against the merge-base lists only the two surfaces.

## For the orchestrator
- `node bin/suite-title-map.js --compare` could NOT be run here: this host lacks the xchain-vm package, so
  mocha dry-run collection errors on integration specs. Please run it in a full checkout. The pin edit follows
  the tool's own serialization (sorted keys, ASCII escaping) and reuses the title-set hash from the earlier round.
- The merge conflict was only in the pin; resolved by taking develop's side and re-adding this row's entry.

RUN-COMPLETE bf224bb166f802545ebc2c69b233e9ef
