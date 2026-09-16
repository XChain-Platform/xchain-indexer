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
 * ROLLCALL structural validation: the carried fields, the DOGE-only and
 * activation checks, the epoch boundary, the fixed hex fields and the v1
 * GATES list. Each check takes the running error and hands it back, so the
 * handler in ./index.js keeps its numbered first-failure-wins order.
 *
 ********************************************************************/

const rca = require('../../rollcall_activation.js');
const rga = require('../../rollcall_gates_activation.js');

// One GATES token: '<module>.<EXPORT>', the identity form the digest emits.
const GATE_TOKEN = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

// The carried fields, read positionally. No field is judged here.
function readRollcallFields(config, params, version){
    let network = String(config['NETWORK']);
    let v1      = (version === 1);

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

    return { network, v1, epochHeight, ledgerHash, publisher, gates, countIdx };
}

// Checks (1) through (4): chain, activation, the one legal version, the epoch
// boundary and the fixed hex fields.
function checkRollcallHeader(config, f, error){
    let { network, v1, epochHeight } = f;

    // (1) DOGE-only. The ANCHOR idiom: gate on the indexer's own coin, so a
    // ROLLCALL payload broadcast on BTC or LTC is stored invalid rather than
    // silently indexed on a chain that has no business judging it.
    if(!error && String(config['COIN']) !== 'DOGE')
        error = 'invalid: ROLLCALL only valid on DOGE';

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
    if(!error && !/^[0-9a-f]{64}$/.test(f.ledgerHash))
        error = 'invalid: LEDGER_HASH';
    if(!error && !/^[0-9a-f]{64}$/.test(f.publisher))
        error = 'invalid: PUBLISHER';

    return error;
}

// (4b) GATES, v1 only: a non-empty comma-joined list of '<module>.<EXPORT>'
// tokens in STRICTLY ascending order. The order is what makes the stored list
// a canonical artifact: the same set spelled in two orders would hash to two
// canonicals and store as two different rows for the same claim, and strict
// ascension rejects a duplicate in the same comparison. The list is never
// checked against THIS build's gates: a publisher naming a gate we do not
// carry is a fact about the publisher, and the BTC-side filter is where it
// is judged.
function checkGates(f, error){
    if(!error && f.v1){
        let gates  = f.gates;
        let tokens = gates.split(',');
        let bad = (gates.length === 0);
        for(let i = 0; !bad && i < tokens.length; i++){
            if(!GATE_TOKEN.test(tokens[i])) bad = true;
            else if(i > 0 && tokens[i] <= tokens[i - 1]) bad = true;
        }
        if(bad) error = 'invalid: GATES';
    }
    return error;
}

module.exports = { readRollcallFields, checkRollcallHeader, checkGates };
