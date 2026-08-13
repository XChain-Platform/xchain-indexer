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
 * XChain Platform Action - BATCH
 * 
 * This action batch executes multiple `ACTION` commands in a single transaction
 * 
 * PARAMS:
 * - VERSION - Format Version
 * - COMMAND - Any valid `ACTION` with `PARAMS`
 * 
 * FORMATS:
 * - 0 = Full (VERSION|COMMAND;COMMAND)
 * 
 ********************************************************************/


class Batch {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.protocolChanges = action.protocolChanges;

        this.formats = {};
        this.formats[0] = 'VERSION|COMMAND';

        // Per-BATCH usage cap for each ACTION (0 = disallowed inside a BATCH).
        this.actionLimits = {};
        this.actionLimits['BATCH'] = 0;
        this.actionLimits['MINT']  = 1;
        this.actionLimits['ISSUE'] = 1;
    }

    // Normalize a sub-action the same way the top-level dispatcher (actions.js)
    // does: rewrite ACTION aliases, then (when params are given) inject the
    // implied legacy VERSION 0 for BTNS-style ISSUE/MINT/SEND params so FORMAT
    // derivation sees a version field. Mutates params in place; returns the
    // canonical ACTION name. Callers only invoke this at/after the
    // BATCH_SUBACTION_NORMALIZATION flag-day; before it, sub-actions keep the
    // historical un-normalized behaviour (aliased names invalidate the BATCH,
    // legacy-format params misparse) for byte-identical replay.
    normalizeSubAction(action, params){
        for(let alias in this.actions.actionAliases){
            if(action == alias)
                action = this.actions.actionAliases[alias];
        }
        if(params && ['ISSUE','MINT','SEND'].includes(action) && this.util.isLegacyActionFormat(params))
            params.splice(0,0,0);
        return action;
    }

    async parse(params, data, error){
        // BATCH_SUBACTION_NORMALIZATION flag-day: when active, sub-actions get the same
        // alias rewrite + legacy VERSION-0 injection as top-level actions. Resolved once
        // per BATCH so every scan below gates identically.
        let normalize = await this.protocolChanges.isEnabled('BATCH_SUBACTION_NORMALIZATION', data['BLOCK_INDEX']);
        // Clone before mutation: this raw copy is what gets stored in the batches table.
        let batch = structuredClone(data);

        let actions = {};

        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        let commands = String(data['TX_DATA']).split(';');
        if(!error && (this.util.isNull(commands) || commands.length < 1)){
            error = 'invalid: COMMAND (unknown)';
        } else {
            // The first command still carries the BATCH|VERSION prefix; strip it.
            commands[0] = commands[0].replace('BATCH|' + format + '|','');
        }

        for(let command of commands){
            let action = String(command).split('|')[0];
            if(normalize)
                action = this.normalizeSubAction(action);
            if(this.util.isNull(actions[action]))
                actions[action] = 0;
            actions[action]++;
        }

        for(let command of commands){
            let action = String(command).split('|')[0];
            if(normalize)
                action = this.normalizeSubAction(action);
            if(!error && await this.protocolChanges.isEnabled(action, data['BLOCK_INDEX']) == false)
                error = 'invalid: ACTION (unknown)';
        }

        for(let action in actions){
            if(!error && Object.keys(this.actionLimits).includes(action) && actions[action] > this.actionLimits[action])
                error = 'invalid: ' + action  + ' (limit)';
        }

        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        let status = (error) ? error : 'valid';
        data['STATUS'] = batch['STATUS'] = status;

        console.log("\t BATCH : " + data['SOURCE'] + ' : ' + data['STATUS']);

        await this.indexerDb.createBatch(batch);

        this.util.addAddressTicker(data['SOURCE']);

        await this.mapper.createMappings(data);

        if(status=='valid'){

            // Pre-parse all sibling commands so child handlers can inspect them
            // (e.g. SEND verifying a paired MESSAGE for gated token transfers).
            // See xchain-documentation/protocol/TOKEN_GATED_CONTENT.md.
            let siblings = [];
            for(let command of commands){
                let parts  = String(command).split('|');
                let name   = String(parts[0]).toUpperCase();
                let sibParams = parts.slice(1);
                if(normalize)
                    name = this.normalizeSubAction(name, sibParams);
                siblings.push({ action: name, params: sibParams, raw: command });
            }
            data['SIBLING_ACTIONS'] = siblings;

            // Snapshot the transaction-level field names. Anything a sub-action
            // adds beyond these is action-specific and must be cleared before the
            // next sub-action runs, otherwise it bleeds across commands (e.g. a
            // FILE leaves FORMAT=0 + ENCRYPTION_METHOD set, and a following
            // MESSAGE v2 then parses under FILE's v0 format (its ciphertext lands
            // in ENCRYPTION_METHOD) and is wrongly rejected).
            let baseKeys = new Set(Object.keys(data));

            let batchPosition = -1;
            for(let command of commands){
                batchPosition++;
                params = String(command).split('|');
                let action = String(params.shift()).toUpperCase();

                // Normalize the sub-action like a top-level action would be
                // (alias rewrite + legacy VERSION-0 injection) so FORMAT
                // derivation and handler dispatch below see canonical input.
                if(normalize)
                    action = this.normalizeSubAction(action, params);

                // Clear action-specific fields left by the previous sub-action.
                for(let key of Object.keys(data))
                    if(!baseKeys.has(key)) delete data[key];

                // Update ACTION transaction data object. FORMAT must be derived
                // from THIS command's version (params[0]) rather than left stale.
                data['ACTION']  = action;
                data['TX_DATA'] = command;
                data['FORMAT']  = this.util.getFormatVersion(params[0]);

                // Each command gets its own ACTION_INDEX.
                data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(data, true);

                // This subcommand's 0-based position in the BATCH's command list.
                // Every subcommand is its own ROOT action but they all share the
                // transaction's single TX_VOUT, so the position is the only
                // content-derived value that tells two same-contract EXECUTE
                // subcommands apart in the ATTEST request_id / XCALL call_id
                // preimages (src/batch_root_discriminator.js; whether it actually
                // enters a preimage is decided by that gate, not here). Set after
                // the clear above, which drops every non-base key each iteration.
                data['BATCH_POSITION'] = batchPosition;

                await this.actions.processAction(action, params, data, error);
            }
        }
    }
}

module.exports = Batch;