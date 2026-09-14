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
 * XChain Platform Action - SEND: legs
 *
 * Reads the SEND wire parameters into legs and consolidates them by
 * DESTINATION and TICK.
 *
 ********************************************************************/

const consolidationLegAmount = require('../../consolidation_leg_amount_activation.js');

// Installed onto Send.prototype by index.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Validate the FORMAT and read the wire parameters into legs of [TICK, AMOUNT, DESTINATION,
    // MEMO]. Returns { error, sends }; an unknown VERSION still yields one leg, so the action
    // leaves a record in sends.
    readSendLegs(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // Example payloads by FORMAT version:
        // let str = '0|JDOG|1|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev';
        // let str = '0|JDOG|1|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|Testing Memos';
        // let str = '1|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9';
        // let str = '1|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|Testing Memos2';
        // let str = '1|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|3|1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8';
        // let str = '1|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|3|1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8|Testing Memos3';
        // let str = '2|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|TEST|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9';
        // let str = '2|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|TEST|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|Testing Memos4';
        // let str = '2|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|TEST|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|BACON|3|1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8';
        // let str = '2|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|TEST|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|BACON|3|1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8|Testing Memos5';
        // let str = '3|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|Testing Memos1|BRRR|5|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|Testing Memos11|TEST|1|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|Testing Memos2|BACON|3|1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8|Testing Memos3';
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Array of sends [TICK, AMOUNT, DESTINATION, MEMO]
        let sends = [];

        // Extract memo
        let memo = null;
        let last = params.length - 1;
        for(let idx in params)
            if(idx==last && ((format==0 && idx==4) || (format==1 && idx%2==0) || (format==2 && idx%3==1)))
                memo = params[idx];

        // If we encountered an invalid version error add it to the sends list so we create a record of it in sends
        if(error)
            sends.push([params[0], params[1], memo]);

        this.pushSendLegs(sends, params, format, memo);
        return { error, sends };
    },

    // Append one leg per wire group, by FORMAT: 0 a single send, 1 a brief multi-send of one
    // TICK, 2 a full multi-send, 3 a full multi-send carrying a MEMO per leg
    pushSendLegs(sends, params, format, memo){
        let lastIdx = params.length - 1;
        for(let idx in params){
            // Force index to integer value (for-in yields string keys)
            idx = parseInt(idx);

            // Single Send
            if(format==0 && idx==0)
                sends.push([params[1], params[2], params[3], memo]);

            // Multi-Send (Brief)
            if(format==1 && idx>1 && idx%2==1)
                sends.push([params[1], params[idx-1], params[idx], memo]);

            // Multi-Send (Full)
            if(format==2 && idx>0 && idx%3==1 && idx < lastIdx)
                sends.push([params[idx], params[(idx+1)], params[idx+2], memo]);

            // Multi-Send (Full) with Multiple Memos
            if(format==3 && idx>0 && idx%4==1 && idx < lastIdx)
                sends.push([params[idx], params[idx+1], params[idx+2], params[idx+3]]);
        }
    },

    // Consolidate sends by DESTINATION and TICK.
    //
    // A leg whose RAW amount fails its tick's format is held OUT of the merge, on its own key,
    // so it reaches the per-leg format check below instead of being summed into a total that
    // passes. bcadd formats to the tick's DECIMALS, so two 0.5 legs of a 0-decimals token
    // merged to '1' and settled while either leg alone was rejected. Gated per chain
    // (consolidation_leg_amount_activation.js): below the threshold the legacy key and merge
    // run unchanged and historical replay stays byte-identical.
    //
    // Above the threshold BOTH key shapes are prefixed ('k' merge key, 'i' held-out leg), so a
    // DESTINATION chosen to spell a held-out leg's key cannot collide with one. Prefixing every
    // key uniformly leaves insertion order (and so the emitted record order) unchanged.
    consolidateSendLegs(sends, ticks, data){
        let legAmountRule = consolidationLegAmount.isConsolidationLegAmountActive(data['BLOCK_TIME'], this.config['NETWORK']);
        let keys = {};
        for(let idx in sends){
            let [tick, amount, destination, memo] = sends[idx];
            let key = destination + '|' + tick;
            if(legAmountRule)
                key = (ticks[tick] && !this.util.isValidAmountFormat(ticks[tick]['DECIMALS'], amount, data['BLOCK_TIME']))
                    ? 'i|' + idx
                    : 'k|' + key;
            if(!this.util.isNull(keys[key]))
                amount = this.util.bcadd(amount, keys[key][1], ticks[tick] && ticks[tick]['DECIMALS']);
            keys[key] = [tick, amount, destination, memo];
        }

        // Update sends using consolidated info
        sends = [];
        for(let key in keys)
            sends.push(keys[key]);
        return sends;
    }
};
