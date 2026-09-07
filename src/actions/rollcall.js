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

const ed25519 = require('../ed25519.js');
const rca     = require('../rollcall_activation.js');
const rga     = require('../rollcall_gates_activation.js');
const { buildRollcallCanonical } = require('../rollcall_canonical.js');

// One GATES token: '<module>.<EXPORT>', the identity form the digest emits.
const GATE_TOKEN = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

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
        if(format === 0 || format === 1) return await this._parseRollcall(params, data, error, format);
    }

    async _parseRollcall(params, data, error, version){

        let network = String(this.config['NETWORK']);
        let v1      = (version === 1);

        // (1) DOGE-only. The ANCHOR idiom: gate on the indexer's own coin, so a
        // ROLLCALL payload broadcast on BTC or LTC is stored invalid rather than
        // silently indexed on a chain that has no business judging it.
        if(!error && String(this.config['COIN']) !== 'DOGE')
            error = 'invalid: ROLLCALL only valid on DOGE';

        let epochHeight = parseInt(params[1]);
        let ledgerHash  = String(params[2] || '').toLowerCase();
        let publisher   = String(params[3] || '').toLowerCase();
        // Carried EXACTLY as published, never re-derived: the canonical the signers
        // signed commits to sha256 of these bytes, and this indexer's own gate list
        // is irrelevant to whether their signatures verify.
        let gates       = v1 ? String(params[4] === undefined || params[4] === null ? '' : params[4]) : null;
        // Where SIG_COUNT sits, and therefore where the pairs start. The only
        // structural difference between the two versions.
        let countIdx    = v1 ? 5 : 4;

        // (2) Activation, keyed on the carried BTC EPOCH_HEIGHT -- the same number
        // the BTC close gates on, NOT this chain's local height. That is what makes
        // a pre-activation roll call inert on both chains without a second
        // DOGE-height flag day to coordinate. isRollcallActive carries the
        // parseInt + Number.isFinite guard every placeholder gate needs, because
        // mainnet ships null and `h >= null` is TRUE in JS.
        if(!error && !rca.isRollcallActive(epochHeight, network))
            error = 'invalid: VERSION (unknown)';

        // (2b) EXACTLY ONE version is legal per epoch, keyed on the same carried
        // EPOCH_HEIGHT. Accepting both either way round would let a publisher choose
        // which canonical the epoch's signers are judged against, and the close would
        // then record two different gate stories for one epoch.
        if(!error && v1 && !rga.isRollcallGatesActive(epochHeight, network))
            error = 'invalid: ROLLCALL v1 before gates activation';
        if(!error && !v1 && rga.isRollcallGatesActive(epochHeight, network))
            error = 'invalid: ROLLCALL v0 after gates activation';

        // (3) Epoch boundary. No staleness or accept-window check here: those
        // compare BTC heights and belong to the BTC close.
        if(!error && !rca.isRollcallEpoch(epochHeight, network))
            error = 'invalid: EPOCH_HEIGHT';

        // (4) Fixed hex fields.
        if(!error && !/^[0-9a-f]{64}$/.test(ledgerHash))
            error = 'invalid: LEDGER_HASH';
        if(!error && !/^[0-9a-f]{64}$/.test(publisher))
            error = 'invalid: PUBLISHER';

        // (4b) GATES, v1 only: a non-empty comma-joined list of '<module>.<EXPORT>'
        // tokens in STRICTLY ascending order. The order is what makes the stored list
        // a canonical artifact: the same set spelled in two orders would hash to two
        // canonicals and store as two different rows for the same claim, and strict
        // ascension rejects a duplicate in the same comparison. The list is never
        // checked against THIS build's gates: a publisher naming a gate we do not
        // carry is a fact about the publisher, and the BTC-side filter is where it
        // is judged.
        if(!error && v1){
            let tokens = gates.split(',');
            let bad = (gates.length === 0);
            for(let i = 0; !bad && i < tokens.length; i++){
                if(!GATE_TOKEN.test(tokens[i])) bad = true;
                else if(i > 0 && tokens[i] <= tokens[i - 1]) bad = true;
            }
            if(bad) error = 'invalid: GATES';
        }

        // (5)/(6) Signature pairs. SIG_COUNT must equal the pair count EXACTLY:
        // a short count would let trailing pairs ride unverified, a long one
        // would read past the end.
        let sigs = [];
        if(!error){
            let declared = parseInt(params[countIdx]);
            let rest     = params.length - (countIdx + 1);
            if(!Number.isFinite(declared) || declared < 1)
                error = 'invalid: SIG_COUNT';
            else if(rest !== declared * 2)
                error = 'invalid: SIG_COUNT';
            else {
                for(let i = 0; i < declared; i++){
                    let pubkey = String(params[countIdx + 1 + 2 * i] || '');
                    let sig    = String(params[countIdx + 2 + 2 * i] || '');
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
        // fields, through the same helper the publishing hub and the BTC close
        // call. Every ROLLCALL that can exist is at or above
        // EQUIV_HEADER_ACTIVATION, so only the wrapped form is ever built; a v1
        // canonical appends sha256(GATES) as carried, so a signer whose build knew
        // a different list verifies against nothing and is simply absent.
        let verified = [];
        if(!error){
            let canonRaw  = buildRollcallCanonical({ network, epochHeight, ledgerHash, gates });
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
                block_index:  data['BLOCK_INDEX'],
                // The RAW carried string, not a re-serialisation of a parsed list:
                // the BTC close re-verifies these signers against a canonical it
                // rebuilds from this column, so any normalisation here would break
                // every signature it re-checks. Null on a v0 row.
                gates:        gates
            })));
        }

        data['STATUS'] = (error) ? error : 'valid';

        console.log("\t ROLLCALL v" + (v1 ? '1' : '0') + " : epoch=" + epochHeight +
                    " signers=" + verified.length + "/" + sigs.length +
                    (v1 ? " gates=" + gates.split(',').length : '') +
                    " publisher=" + publisher.substring(0, 16) + '...' +
                    " status=" + data['STATUS']);

        return data;
    }
}

module.exports = Rollcall;
