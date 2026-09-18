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
 * XChain Indexer - Platform-train activation gate
 *
 * The block loop's pre-apply gate: resolve the trainActivation block of the signed
 * release manifest this node was installed from, evaluate it for the block about to
 * be applied, and write the durable halt marker when the node must not apply it.
 * Installed onto XChainIndexer.prototype by ../XChainIndexer.js.
 *
 ********************************************************************/

const fs              = require('fs');
const path            = require('path');
const trainActivation = require('../consensus/gates/train_gate.js');
const { getLogger }   = require('../observability/index.js');

module.exports = {

    // The trainActivation block of the signed release manifest this node was installed
    // from. The carrier ships the manifest and the components ship the vendored
    // TRAIN_ACTIVATION map, which is exactly why the comparison is worth making: a
    // partial upgrade (new carrier, stale component image) is the shape a post-launch
    // MAJOR train forks in, and it is invisible to every per-feature flag day.
    //
    // Resolved from config['RELEASE_MANIFEST_PATH'] when the deployment sets one,
    // otherwise from the carrier's copy beside this checkout. NO manifest is NOT a
    // fault and is not a halt: nothing then names a rule set, which is the honest
    // reading of an install that has no manifest to require one. A manifest that
    // exists and cannot be PARSED is a different matter and is reported as malformed,
    // which evaluateTrainActivation halts on fail-closed.
    resolveTrainActivationRequirement(){
        if(this._trainActivationRequired !== undefined) return this._trainActivationRequired;
        let candidates = [];
        if(this.config && this.config['RELEASE_MANIFEST_PATH'])
            candidates.push(String(this.config['RELEASE_MANIFEST_PATH']));
        // Three levels up from this part's directory (src/XChainIndexer/) is the platform
        // root, where the carrier checkout sits beside this one.
        candidates.push(path.resolve(__dirname, '../../../xchain-node/src/release-manifest.json'));
        for(const file of candidates){
            let raw;
            try {
                if(!fs.existsSync(file)) continue;
                raw = fs.readFileSync(file, 'utf8');
            } catch(e){
                // Present but unreadable. Do NOT cache: a permissions fix or a
                // completed atomic rename should be picked up on the next block.
                return { malformed: 'release manifest at ' + file + ' could not be read (' + (e && e.message) + ')' };
            }
            let parsed;
            try { parsed = JSON.parse(raw); }
            catch(e){ return { malformed: 'release manifest at ' + file + ' is not valid JSON' }; }
            this._trainActivationRequired = trainActivation.readManifestTrainActivation(parsed);
            return this._trainActivationRequired;
        }
        this._trainActivationRequired = null;
        return null;
    },

    // Evaluate the train gate for the block about to be applied and return TRUE when the
    // loop must not apply it. Also keeps this.trainActivation current for health, which is
    // how the halt is announced BEFORE it fires: the `pending` verdict is published from
    // the moment the manifest names an unimplemented rule set, not at the boundary.
    //
    // The clock is the BTC height. A BTC indexer's own block_index IS that height; off BTC
    // there is none in this path, so null is passed and the gate treats an unimplemented
    // requirement as fail-closed (see the header of src/consensus/gates/train_gate.js). Never throws
    // into the block loop: an unexpected fault in the gate itself is reported and halts,
    // because a gate that cannot decide must not wave the block through.
    async checkTrainActivation(blockToParse){
        let verdict;
        try {
            verdict = trainActivation.evaluateTrainActivation({
                height:   (this.config['COIN'] === 'BTC') ? blockToParse : null,
                network:  this.config['NETWORK'],
                required: this.resolveTrainActivationRequirement()
            });
        } catch(e){
            verdict = {
                status: 'halt', activeRuleSet: null, requiredRuleSet: null, requiredAtHeight: null,
                network: this.config['NETWORK'], height: blockToParse, classification: null,
                reason: 'train_activation: the activation gate itself failed to evaluate (' +
                        (e && e.message) + '); refusing to advance'
            };
        }
        this.trainActivation = verdict;

        if(verdict.status === 'clear'){
            if(this.stallReason && /^train_activation_halt:/.test(this.stallReason)){
                this.stallReason   = null;
                this.stallClearsAt = null;
            }
            return false;
        }

        if(verdict.status === 'pending'){
            // Loud on the transition, then periodic, so the announcement cannot be missed
            // and cannot drown the log during a long rolling-upgrade window.
            if((this._trainActivationHaltLogTick++ % 60) === 0)
                getLogger().error('XChainIndexer: TRAIN ACTIVATION PENDING - ' + verdict.reason);
            return false;
        }

        // HALT. Durable, because the next block is the forked one: a node that forgot its
        // halt across a restart would apply it. The marker is written once (the read below
        // is what keeps a deferring loop from inserting one row per poll).
        if((this._trainActivationHaltLogTick++ % 60) === 0)
            getLogger().error('XChainIndexer: TRAIN ACTIVATION HALT at block ' + blockToParse + ' - ' + verdict.reason +
                ' REQUIRED OPERATOR ACTION: update this node to the platform version that carries the ' +
                'required rule set. Clearing the marker by hand is not a supported path.');
        this.stallReason   = 'train_activation_halt: ' + verdict.reason;
        this.stallClearsAt = null;
        await this.recordTrainActivationHalt(blockToParse, verdict);
        return true;
    },

    // Write the durable halt marker, once. `events.data` is a VARCHAR(250), so the payload
    // carries the machine-readable fields (the required rule set, its height, the block the
    // halt fired at) and not the prose reason, which the log and health already carry in
    // full. A marker write that fails is logged and the halt still holds: the halt is a
    // refusal to advance, and it must not depend on a successful INSERT.
    async recordTrainActivationHalt(blockToParse, verdict){
        if(!this.indexerDb || typeof this.indexerDb.doQuery !== 'function') return;
        try {
            let existing = await this.indexerDb.getLatestTrainActivationHaltEvent();
            if(Array.isArray(existing) && existing.length > 0) return;
            let payload = JSON.stringify({
                requiredRuleSet:  verdict.requiredRuleSet || null,
                requiredAtHeight: verdict.requiredAtHeight === undefined ? null : verdict.requiredAtHeight,
                network:          verdict.network || null,
                haltedAtBlock:    blockToParse
            }).slice(0, 250);
            await this.indexerDb.recordTrainActivationHaltEvent(payload);
        } catch(e){
            getLogger().warn('XChainIndexer: could not record the TRAIN_ACTIVATION_HALT marker (' +
                (e && e.message) + '); the halt still holds.');
        }
    }
};
