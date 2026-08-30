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
 * UNION SEMANTICS. Any number of ROLLCALL actions may land for one epoch, from
 * anyone. The present set is the UNION of every valid signature inside the
 * window, so a publisher can add signers but never remove them and nobody holds
 * the absence list. A validator left out of the leader's action is placed by any
 * sweeper, or publishes its own one-signature roll call.
 *
 ********************************************************************/

const ed25519 = require('../ed25519.js');
const eq      = require('../equivocation_header.js');
const rca     = require('../rollcall_activation.js');

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
    }

    // Dispatch on VERSION (only v0 today).
    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';
        if(format === 0) return await this._parseRollcall(params, data, error);
    }

    async _parseRollcall(params, data, error){

        let network = String(this.config['NETWORK']);

        // (1) DOGE-only. The ANCHOR idiom: gate on the indexer's own coin, so a
        // ROLLCALL payload broadcast on BTC or LTC is stored invalid rather than
        // silently indexed on a chain that has no business judging it.
        if(!error && String(this.config['COIN']) !== 'DOGE')
            error = 'invalid: ROLLCALL only valid on DOGE';

        let epochHeight = parseInt(params[1]);
        let ledgerHash  = String(params[2] || '').toLowerCase();
        let publisher   = String(params[3] || '').toLowerCase();

        // (2) Activation, keyed on the carried BTC EPOCH_HEIGHT -- the same number
        // the BTC close gates on, NOT this chain's local height. That is what makes
        // a pre-activation roll call inert on both chains without a second
        // DOGE-height flag day to coordinate. isRollcallActive carries the
        // parseInt + Number.isFinite guard every placeholder gate needs, because
        // mainnet ships null and `h >= null` is TRUE in JS.
        if(!error && !rca.isRollcallActive(epochHeight, network))
            error = 'invalid: VERSION (unknown)';

        // (3) Epoch boundary. No staleness or accept-window check here: those
        // compare BTC heights and belong to the BTC close.
        if(!error && !rca.isRollcallEpoch(epochHeight, network))
            error = 'invalid: EPOCH_HEIGHT';

        // (4) Fixed hex fields.
        if(!error && !/^[0-9a-f]{64}$/.test(ledgerHash))
            error = 'invalid: LEDGER_HASH';
        if(!error && !/^[0-9a-f]{64}$/.test(publisher))
            error = 'invalid: PUBLISHER';

        // (5)/(6) Signature pairs. SIG_COUNT must equal the pair count EXACTLY:
        // a short count would let trailing pairs ride unverified, a long one
        // would read past the end.
        let sigs = [];
        if(!error){
            let declared = parseInt(params[4]);
            let rest     = params.length - 5;
            if(!Number.isFinite(declared) || declared < 1)
                error = 'invalid: SIG_COUNT';
            else if(rest !== declared * 2)
                error = 'invalid: SIG_COUNT';
            else {
                for(let i = 0; i < declared; i++){
                    let pubkey = String(params[5 + 2 * i] || '');
                    let sig    = String(params[5 + 2 * i + 1] || '');
                    // Accept either case on the wire, lowercase before use.
                    if(!/^[0-9a-fA-F]{64}$/.test(pubkey) || !/^[0-9a-fA-F]{128}$/.test(sig))
                        continue;
                    sigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
                }
            }
        }

        // (7) Never inside a BATCH. The check lives HERE rather than in the BATCH
        // cap table because a row added to that table applies retroactively and
        // would fork a replay.
        if(!error && data['BATCH_POSITION'] !== undefined && data['BATCH_POSITION'] !== null)
            error = 'invalid: ROLLCALL (not batchable)';

        // Verify each signature over the canonical rebuilt from the CARRIED
        // fields. Every ROLLCALL that can exist is at or above
        // EQUIV_HEADER_ACTIVATION, so only the wrapped form is ever built.
        let verified = [];
        if(!error){
            let content   = network + '|' + epochHeight + '|' + ledgerHash;
            let canonRaw  = eq.buildEquivCanonical(eq.ENGINE_TAGS.ROLLCALL, String(epochHeight), 0, content);
            let canonical = Buffer.from(canonRaw, 'utf8');

            let seen = new Set();
            for(let s of sigs){
                if(seen.has(s.pubkey)) continue;
                if(!ed25519.verify(canonical, s.sig, s.pubkey)) continue;
                // Mark seen only AFTER the signature verifies. Marking on first
                // encounter lets a garbage-then-valid pair for one key suppress
                // the real signature, which would read as an absence and, over K
                // epochs, evict a validator that was demonstrably present.
                seen.add(s.pubkey);
                verified.push(s);
            }

            // A roll call carrying no signature that verifies is not a roll call.
            if(verified.length === 0)
                error = 'invalid: SIG_COUNT';
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
                block_index:  data['BLOCK_INDEX']
            })));
        }

        data['STATUS'] = (error) ? error : 'valid';

        console.log("\t ROLLCALL v0 : epoch=" + epochHeight +
                    " signers=" + verified.length + "/" + sigs.length +
                    " publisher=" + publisher.substring(0, 16) + '...' +
                    " status=" + data['STATUS']);

        return data;
    }
}

module.exports = Rollcall;
