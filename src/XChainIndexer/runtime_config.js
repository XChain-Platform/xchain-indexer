/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - Runtime config
 *
 * The config start() resolves before it creates anything: this process's indexer
 * config, the two graces that must be fixed at startup rather than inside the block
 * loop, the shared utility over that same config object, and the consensus pin check
 * on the bundled coin files. Installed onto XChainIndexer.prototype by ../XChainIndexer.js.
 *
 ********************************************************************/

const config = require('../config.js');
const coins  = require('../coins');
const util   = require('../utility.js');
// The frozen call-barrier grace and its resolver, shared with the direct-hub-DB
// (no-mirror) call-presence barrier so both paths open on the SAME constant.
const { HUB_SYNC_WATERMARK_GRACE_S, resolveWatermarkGrace } = require('../hub/hub_db_sync.js');
const { ANCHOR_ATTEST_ARRIVAL_MARGIN_S } = require('../consensus/gates/anchor_reward_gate.js');
const { getLogger } = require('../observability/index.js');

module.exports = {

    // Resolve this process's indexer config and the two graces that must be fixed at
    // startup (never inside the block loop), create the utility over that same config
    // object, and verify the bundled coin files against the consensus pin.
    resolveRuntimeConfig(){
        // Get indexer configuration
        this.config = config.getConfig();

        // Resolve the direct-hub-DB call barrier's grace now that NETWORK is known. Same
        // constant, same env override, same regtest-only rules as the mirrored path.
        this.directCallGraceS = resolveWatermarkGrace(
            HUB_SYNC_WATERMARK_GRACE_S.call, 'HUB_SYNC_CALL_GRACE_S', this.config['NETWORK']);

        // Same shape, same contract, for the anchor-attest maturity-horizon margin: honoured
        // on regtest, throws on a non-integer there, IGNORED with a warning off regtest.
        this.anchorAttestArrivalMarginS = resolveWatermarkGrace(
            ANCHOR_ATTEST_ARRIVAL_MARGIN_S, 'HUB_SYNC_ANCHOR_ATTEST_ARRIVAL_MARGIN_S', this.config['NETWORK']);

        // Create instance of the utility class, sharing the indexer's single
        // config object (NOT a fresh getConfig()) so a later hub overlay can't
        // make this.config and this.util.config diverge.
        this.util = new util(this.config);

        // Guard the shared-config invariant: every block-processing module reads
        // this.config, and the hub overlay mutates it in place, so util MUST hold
        // the same object. Construction above guarantees it; this catches a future
        // refactor that reintroduces the divergence without bricking startup.
        if(this.util.config !== this.config)
            getLogger().error('CONFIG WIRING BUG: indexer.config and util.config are not the same object; a hub overlay could desync consensus reads.');

        // Verify the bundled canonical coin files against CONSENSUS_CONFIG_PIN before
        // processing any block. A null pin (mainnet, pre-arm) skips; a mismatch on an
        // armed network halts, exactly like genesis.js' ledger-hash check. This catches
        // a vendored coin file that drifted from the pinned consensus config.
        coins.verifyConsensusPin(this.config.NETWORK);
    }
};
