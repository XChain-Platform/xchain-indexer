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
 * XChain Platform Action - VOTE : column fit
 *
 * The last checks a VOTE create (v0) and a ballot (v1) pass: that every value the
 * action writes is one its column stores. The rules in ./validate.js read these fields
 * through Number, parseInt or the bc helpers, which admit spellings, magnitudes and
 * widths a strict session refuses on the bind, and such an action failed its insert, or
 * its poll's finalize did, and retried that block forever on every indexer. No indexed
 * history gets past one, so these refusals need no activation height. Each runs after
 * every other verdict, so a refused action keeps its own, and each judges exactly the
 * value the row writer binds.
 * Called with the VOTE handler as `this` (see ./index.js).
 *
 ********************************************************************/

'use strict';

const { exceedsCodePoints } = require('../../db/column_text.js');
const { fitsUtf8mb3 }       = require('../../db/utf8mb3.js');

// polls.end_block, polls.min_voters, polls.callback_delay_blocks and votes.poll_index are
// BIGINT UNSIGNED; polls.max_selections and votes.choice are SMALLINT UNSIGNED.
const U64_MAX = '18446744073709551615';
const U16_MAX = '65535';

// polls.quorum, polls.min_vote_balance, polls.decide_threshold and votes.share are VARCHAR(60).
const NUMERIC_TEXT_MAX_CHARS = 60;

// The finalize writes one poll_results row per stored option, its index in a SMALLINT
// UNSIGNED (and the winner in polls.winning_option, the same type): 65536 entries at most.
const MAX_STORED_OPTIONS = 65536;

// The finalize stamps a timelocked callback_due_block (BIGINT UNSIGNED) as a Number, and the
// driver writes its decimal, so 2^64 is the first stamp the column refuses. No finalize runs
// past block 2^53: the catch-up loop advances with Number(lastIndexerBlock) + 1, which stops there.
const DUE_BLOCK_OVERFLOW     = 2 ** 64;
const LAST_PROCESSABLE_BLOCK = 2 ** 53;
// end_block rounds half away from zero, so it stores at 2^53 or below exactly when the wire
// value is below this.
const LAST_PROCESSABLE_ROUNDING_EDGE = '9007199254740992.5';

// VOTE v0 phase - the live poll row. createPoll binds END_BLOCK, MAX_SELECTIONS and
// MIN_VOTERS raw (a 23-digit END_BLOCK, MIN_VOTERS=1e30 and MAX_SELECTIONS=0x2 each failed
// the bind) and CALLBACK_DELAY_BLOCKS as parseInt reads it, on a binding poll only: a delay
// of '0x10' stores 16 and stays valid.
function validateCreateStorable(data, error){
    if(!error && !this.util.storesInIntegerColumn(data['END_BLOCK'], '0', U64_MAX))
        error = 'invalid: END_BLOCK (format)';
    if(!error && !this.util.storesInIntegerColumn(data['MAX_SELECTIONS'], '0', U16_MAX))
        error = 'invalid: MAX_SELECTIONS (format)';
    if(!error && !this.util.isNull(data['MIN_VOTERS']) && !this.util.storesInIntegerColumn(data['MIN_VOTERS'], '0', U64_MAX))
        error = 'invalid: MIN_VOTERS (format)';
    if(!error && data['IS_BINDING'] && !this.util.isNull(data['CALLBACK_DELAY_BLOCKS']) &&
       !this.util.storesInIntegerColumn(parseInt(data['CALLBACK_DELAY_BLOCKS']), '0', U64_MAX))
        error = 'invalid: CALLBACK_DELAY_BLOCKS (format)';
    if(!error && data['IS_BINDING'] && !this.util.isNull(data['CALLBACK_DELAY_BLOCKS']) && callbackDueOverflows(this.util, data))
        error = 'invalid: CALLBACK_DELAY_BLOCKS (format)';
    error = optionCountError.call(this, data, error);
    return createTextError.call(this, data, error);
}

// Whether a stored delay makes the finalize stamp a due block its column refuses, which
// retries that block forever, so no indexed history holds one. The time sweep closes a poll
// at end_block exactly (every block runs it, in order) and an early decide closes it sooner;
// rounding is monotone, so the Number sum fireBindingCallback computes at the last block a
// poll can close, the stored end_block or 2^53, is the largest stamp it can ever write. A
// delay of 0 takes the immediate path and stamps nothing. The check stays in Number to match
// the stamp: above 2^63 the parsed delay and the sum both round to multiples of 2048.
function callbackDueOverflows(util, data){
    let delay = parseInt(data['CALLBACK_DELAY_BLOCKS']);
    if(!(delay > 0)) return false;
    let lastClose = Math.min(Number(util.bcround(data['END_BLOCK'], 0)), LAST_PROCESSABLE_BLOCK);
    return lastClose + delay >= DUE_BLOCK_OVERFLOW;
}

// createPoll stores every comma-separated OPTIONS entry, empty ones included, so a poll can
// store more entries than its option count, and its finalize failed the poll_results insert
// of index 65536 (errno 1264). The time sweep finalizes a poll at its stored end_block when
// the indexer reaches that block, so the create is refused only then; a poll whose end_block
// lies past 2^53 never closes by time and stays valid.
function optionCountError(data, error){
    if(error || String(data['OPTIONS']).split(',').length <= MAX_STORED_OPTIONS) return error;
    if(!this.util.bclt(data['END_BLOCK'], LAST_PROCESSABLE_ROUNDING_EDGE)) return error;
    return 'invalid: OPTIONS (format)';
}

// QUORUM, MIN_VOTE_BALANCE and DECIDE_THRESHOLD pass rules that read them as numbers of any
// digit count, and createPoll binds each as its wire text into a VARCHAR(60), so a longer one
// failed the insert (errno 1406). The wire parser trims every field, so no trailing space
// reaches the bind and the column's silent trailing-space cut never applies. CALLBACK_PARAMS
// binds raw on a binding poll only, into polls.callback_params, which keeps the table's
// utf8mb3 charset, so a supplementary-plane character there failed it (errno 1366).
function createTextError(data, error){
    for(let field of ['QUORUM', 'MIN_VOTE_BALANCE', 'DECIDE_THRESHOLD'])
        if(!error && exceedsCodePoints(data[field], NUMERIC_TEXT_MAX_CHARS))
            error = 'invalid: ' + field + ' (format)';
    if(!error && data['IS_BINDING'] && !this.util.isNull(data['CALLBACK_PARAMS']) && !fitsUtf8mb3(data['CALLBACK_PARAMS']))
        error = 'invalid: CALLBACK_PARAMS (format)';
    return error;
}

// VOTE v1 phase - the votes row. createBallot binds POLL_REF raw, though the poll was looked
// up by parseInt, so '0x5' or '5e30' named poll 5 and then failed the BIGINT UNSIGNED bind
// (errno 1366 or 1264); '5.4' stores 5 and stays valid. It binds each selection's choice into
// a SMALLINT UNSIGNED, past which only a poll storing more than 65536 entries can offer a
// choice, and a split share as its trimmed text into a VARCHAR(60) (errno 1264 or 1406).
function validateBallotStorable(data, selections, error){
    if(!error && !this.util.storesInIntegerColumn(data['POLL_REF'], '0', U64_MAX))
        error = 'invalid: POLL_REF (format)';
    for(let i = 0; !error && i < selections.length; i++){
        if(!this.util.storesInIntegerColumn(selections[i].choice, '0', U16_MAX))
            error = 'invalid: BALLOT (format)';
        else if(exceedsCodePoints(selections[i].share, NUMERIC_TEXT_MAX_CHARS))
            error = 'invalid: BALLOT (length)';
    }
    return error;
}

module.exports = { validateCreateStorable, validateBallotStorable };
