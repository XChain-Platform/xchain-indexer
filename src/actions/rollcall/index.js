/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * XChain Platform Action - ROLLCALL (validator liveness presence proof)
 *
 * A set of Ed25519 signatures over a canonical bound to a BITCOIN epoch
 * block's ledger_hash, landed on DOGECOIN. Binding the message to that hash is
 * the whole liveness claim: it cannot be signed before the epoch block is
 * mined, so a valid signature shows the key was operating, with a synced view
 * of the BTC chain, inside the epoch's accept window. A pre-signed stack of
 * future heartbeats -- the trivial defeat of an unbound canonical -- is
 * impossible.
 *
 * THIS HANDLER DECIDES STRUCTURE ONLY. The DOGE indexer has no BTC view: no
 * stake rows (coins/DOGE.js CAPABILITIES {}), no BTC ledger hashes, no
 * responsible set. It cannot check LEDGER_HASH against anything, and it does
 * not try. Every question about WHO the signers are -- membership, weight,
 * quorum, absence, eviction -- is answered BTC-side at the epoch close, which
 * re-verifies every signature against its OWN ledger_hash and discards any row
 * whose carried hash differs. Nothing decided here reaches that verdict.
 *
 * TWO VERSIONS, ONE LEGAL PER EPOCH. v1 adds a GATES field naming the consensus
 * gates the signers' build knows, and its canonical commits to sha256(GATES).
 * Which version is legal is decided by the carried EPOCH_HEIGHT against
 * ROLLCALL_GATES_ACTIVATION, so a v1 below the height and a v0 at or above it are
 * both invalid: one epoch, one canonical, one gate story. This handler never
 * compares the carried list against its own gates; that comparison happens
 * BTC-side, at a request block, against the gates active there.
 *
 * UNION SEMANTICS. Any number of ROLLCALL actions may land for one epoch, from
 * anyone. The present set is the UNION of every valid signature inside the
 * window, so a publisher can add signers but never remove them and nobody holds
 * the absence list. A validator left out of the leader's action is placed by any
 * sweeper, or publishes its own one-signature roll call.
 *
 ********************************************************************/

const validate   = require('./validate.js');
const signatures = require('./signatures.js');

const { getLogger } = require('../../observability/index.js');

class Rollcall {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|EPOCH_HEIGHT|LEDGER_HASH|PUBLISHER|SIG_COUNT|PUBKEY|SIG|...';
        // v1 inserts GATES between PUBLISHER and SIG_COUNT. It cannot ride v0: v0 is
        // positional and length-exact (a trailing parameter is 'invalid: SIG_COUNT'),
        // so the list needs a version of its own.
        this.formats[1] = 'VERSION|EPOCH_HEIGHT|LEDGER_HASH|PUBLISHER|GATES|SIG_COUNT|PUBKEY|SIG|...';
    }

    // Dispatch on VERSION. Both versions share one body: the only differences are
    // one field's presence and the offset it pushes the pairs to, and a second copy
    // of a consensus parser is a second set of bytes to drift.
    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';
        if(format === 0 || format === 1) return await this.parseRollcall(params, data, error, format);
    }

    async parseRollcall(params, data, error, version){

        // The carried fields and checks (1) through (4b), in order (validate.js).
        let f = validate.readRollcallFields(this.config, params, version);
        let { v1, epochHeight, ledgerHash, publisher, gates } = f;
        error = validate.checkRollcallHeader(this.config, f, error);
        error = validate.checkGates(f, error);

        // (5)/(6) The length-exact signature pairs (signatures.js).
        let pairs = signatures.parseSigPairs(params, f.countIdx, error);
        let sigs = pairs.sigs;
        error = pairs.error;

        // (7) Never inside a BATCH. The check lives HERE rather than in the BATCH
        // cap table because a row added to that table applies retroactively and
        // would fork a replay.
        if(!error && data['BATCH_POSITION'] !== undefined && data['BATCH_POSITION'] !== null)
            error = 'invalid: ROLLCALL (not batchable)';

        // Each signature verified over the canonical rebuilt from the carried
        // fields (signatures.js); none verifying is 'invalid: SIG_COUNT'.
        let verified = [];
        if(!error){
            let checked = signatures.verifyRollcallSigners(f, sigs);
            verified = checked.verified;
            error = checked.error;
        }

        // (8) No quorum, no membership, no absence. Deliberately absent from this
        // handler: all of it is BTC-side.
        if(!error){
            await this.indexerDb.insertRollcallSigners(verified.map((s) => ({
                epoch_height: epochHeight,
                pubkey:       s.pubkey,
                sig:          s.sig,
                ledger_hash:  ledgerHash,
                publisher:    publisher,
                action_index: data['ACTION_INDEX'],
                block_index:  data['BLOCK_INDEX'],
                // The RAW carried string, not a re-serialisation of a parsed list:
                // the BTC close re-verifies these signers against a canonical it
                // rebuilds from this column, so any normalisation here would break
                // every signature it re-checks. Null on a v0 row.
                gates:        gates
            })));
        }

        data['STATUS'] = (error) ? error : 'valid';

        getLogger().info("\t ROLLCALL v" + (v1 ? '1' : '0') + " : epoch=" + epochHeight +
                    " signers=" + verified.length + "/" + sigs.length +
                    (v1 ? " gates=" + gates.split(',').length : '') +
                    " publisher=" + publisher.substring(0, 16) + '...' +
                    " status=" + data['STATUS']);

        return data;
    }
}

module.exports = Rollcall;
