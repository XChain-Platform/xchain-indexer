# Lane report: cx-xc-5885

Files touched: src/protocol_changes/changes_5.js (merge of origin/develop 3bfbcb84 into the lane commit cfb9a8ed; one conflict, resolved).

Resolution: develop had meanwhile added a local exactIntegerWireRegtestTime() (unset or empty gives 0, a non-negative integer gives that height, anything else UNARMED). This row replaces that with the shared regtestTimeOverride('EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME'), so I kept the row's version and dropped the local function. Behaviour: unset gives 0 (armed from genesis), a positive height arms at that height, matching the decoder and e2e readers that use the same override.

Difference from develop to note: a non-numeric value such as "off" now yields 0 (armed) through the shared override, where develop's local function gave UNARMED. This follows the row's acceptance (all three readers share one grammar); the orchestrator should confirm no venue relies on "off".

Tests: none run (the lane starts no repository-wide run). Only checked that changes_5.js loads under node with the variable set empty. 0 pass, 0 fail counted.

Push gate note: the earlier failure was a plain content conflict in changes_5.js between develop's new local function and this row's change; the gate's reason was accurate. It is resolved by this merge.

RUN-COMPLETE 505fc4b26aa1adf93b55381ac7411c12
