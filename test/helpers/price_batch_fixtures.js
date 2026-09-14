/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/helpers/price_batch_fixtures.js
 *
 * The PRICE v0 compression fixtures shared by
 * test/unit/price_batch_compression.test.js and the parts under
 * test/unit/price_batch_compression.test/, so every part measures and mangles the
 * same bodies and the same base64 spellings.
 *
 ********************************************************************/

'use strict';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A realistic six-round PRICE v0 body: everything after "PRICE|0|" on the
// uncompressed wire. Built rather than pasted so the shape stays honest, and
// so the ratio this suite records is a measurement of real oracle data
// (repeated pair names, near-repeated prices, high-entropy hex signatures)
// rather than of a compressible synthetic string.
function buildRealisticV2Body(sigCount){
    const SIGS = (sigCount === undefined) ? 5 : sigCount;
    const TICKERS = ['BTC','LTC','DOGE','XCHAIN','ETH','BCH','DASH','ZEC','XMR','ADA',
                     'SOL','DOT','LINK','UNI','AVAX','MATIC','ATOM','XLM','TRX','ALGO'];
    const FIATS   = ['USD','EUR','GBP'];

    // 37 pairs: the 36-pair production set plus XCHAIN/USD, which is the pair
    // every native-coin fee decision needs.
    let pairNames = [];
    for(const t of TICKERS){
        for(const f of FIATS){
            if(pairNames.length < 37) pairNames.push(t + '/' + f);
        }
    }

    const firstRound = 481200;
    const lastRound  = 481205;
    const anchor     = 918442;

    let out = [String(firstRound), String(lastRound), String(anchor), '6'];

    for(let i = 0; i < 6; i++){
        const round = firstRound + i;
        out.push(String(round));
        out.push(String(1756180800 + i * 600));
        out.push(String(anchor + i));
        out.push(String(pairNames.length));
        for(let p = 0; p < pairNames.length; p++){
            out.push(pairNames[p]);
            // Prices drift slightly round to round, as real oracle medians do.
            out.push((1000 + p * 137.4 + i * 0.37).toFixed(8));
        }
    }

    // Hex pubkeys and signatures are near-incompressible, so the signature set
    // sets the floor on what deflate can achieve and drives the signer-count ceiling.
    out.push(String(SIGS));
    for(let s = 0; s < SIGS; s++){
        out.push(hex(64, s * 7 + 1));
        out.push(hex(128, s * 11 + 3));
    }

    return out.join('|');
}

// Deterministic pseudo-random hex, so the recorded ratio is reproducible.
function hex(chars, seed){
    let out = '';
    let x = (seed * 2654435761) >>> 0;
    while(out.length < chars){
        x = (x * 1664525 + 1013904223) >>> 0;
        out += x.toString(16).padStart(8, '0');
    }
    return out.slice(0, chars);
}

// A canonical-base64 field carrying arbitrary bytes, bypassing the compressor
// so a test can hand the decoder exactly the bytes it wants to.
function fieldOf(buf){ return Buffer.from(buf).toString('base64'); }

// Given a canonical base64 string with padding, find a different string that
// Buffer.from decodes to the SAME bytes. This exists only in padded forms,
// where the final quantum has unused low bits that a lenient decoder ignores.
function alternateSpelling(canonical){
    if(!canonical.endsWith('=')) return null;
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const idx  = canonical.replace(/=+$/, '').length - 1;
    const want = Buffer.from(canonical, 'base64');
    for(const ch of ALPHABET){
        if(ch === canonical[idx]) continue;
        const alt = canonical.slice(0, idx) + ch + canonical.slice(idx + 1);
        if(Buffer.from(alt, 'base64').equals(want)) return alt;
    }
    return null;
}

module.exports = { buildRealisticV2Body, hex, fieldOf, alternateSpelling };
