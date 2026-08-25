/********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 * PROTOCOL TIME
 *
 * Everything time-keyed in the protocol (the price/oracle/fiat reads, and the
 * six mirror barriers in XChainIndexer.js) currently keys on a block's RAW
 * timestamp. That value is chosen by whoever mined the block, and Bitcoin
 * accepts it up to ~2h ahead of network-adjusted time. Two consequences, one
 * per network:
 *
 *   - testnet4 rides the 20-minute minimum-difficulty rule continuously,
 *     stamping each block ~1201s after its parent, so its tip runs hours ahead
 *     of wall clock. A barrier that waits for mirrored data to cover a future
 *     stamp cannot clear until wall clock catches up, which is why a confirmed
 *     transaction could take ~2h to index.
 *   - on mainnet the same field is a miner-controlled input to consensus.
 *
 * The fix for both is the same one Bitcoin adopted for locktime in BIP113:
 * stop reading the raw stamp and read the MEDIAN of the previous 11 block
 * timestamps instead. That value is derived from the chain (so every node
 * computes it identically), monotonically non-decreasing, and cannot be pushed
 * into the future by a single miner. Measured against live testnet4 on
 * 2026-08-25 (blocks 149798-149809, every one spaced exactly 1201s), MTP ran
 * 8684-15891s BEHIND wall clock across the whole sample, so the barriers clear
 * immediately even on the chain that motivated this.
 *
 * NO FLAG DAY, DELIBERATELY (operator ruling 2026-08-25). An activation height
 * only earns its keep when there is history on the far side of it to preserve.
 * testnet was re-genesised 2026-08-24 and carries nothing that depends on the
 * old reads, so a height would be an arbitrary line drawn through an empty
 * chain and a re-index settles it either way. The switch is therefore per
 * NETWORK, not per height: on for testnet and regtest, off for mainnet, which
 * is left alone because mainnet stamps track wall clock and nothing there is
 * broken.
 *
 * WHAT MUST MOVE TOGETHER. Every reader of hub-MIRRORED data (price_snapshots,
 * oracle_prices, matches, calls, snapshots, attestations) and the barriers that
 * gate them must use the same clock. Barriers on MTP while a read still keys on
 * the raw stamp is the dangerous half: the node proceeds into a price window
 * that is still growing and forks. That is why this is applied at getBlockTime,
 * the single seam every protocol reader already flows through, rather than
 * threaded call site by call site where one could be missed.
 *
 ********************************************************************/

// How many preceding blocks the median is taken over. Bitcoin's value; changing
// it moves the instant every block reads at, so it is a consensus constant.
const MEDIAN_TIME_SPAN = 11;

// Networks whose protocol time is resolved from MTP rather than the raw stamp.
//
// testnet is the one that needs it: testnet4 stamps into the future continuously
// and that is what stalled indexing.
//
// mainnet is off because its timestamps track wall clock, so this is a hardening
// there rather than a fix, and flipping a chain already indexing real blocks is a
// deliberate operator decision, not a side effect of a testnet repair.
//
// regtest is off on purpose too, and it is the less obvious call. Regtest block
// times are driven by the harness (setmocktime, a frozen or jumped clock), so a
// median over 11 of them is not the well-behaved quantity it is on a live chain,
// and the e2e fee-era and price-window suites are calibrated against the raw
// stamp. Switching it would risk destabilising the venue that validates
// everything else in order to fix a problem regtest does not have. The MTP logic
// itself is covered by unit tests instead.
const PROTOCOL_TIME_MTP_NETWORKS = {
    mainnet: false,
    testnet: true,
    regtest: false,
};

// Whether `network` resolves protocol time from MTP. An unknown network reads
// false, so an unrecognised caller keeps the raw-stamp behaviour rather than
// silently switching which instant consensus reads at.
function isProtocolTimeMtpActive(network){
    return PROTOCOL_TIME_MTP_NETWORKS[network] === true;
}

// The median of the previous MEDIAN_TIME_SPAN block timestamps, Bitcoin-style.
//
// `previousBlockTimes` is the timestamps of the blocks BELOW the one being
// resolved, in any order; only the newest MEDIAN_TIME_SPAN of them are used, so
// callers may hand over a longer window. Genesis and the blocks just above it
// have fewer than a full span available: Bitcoin medians whatever exists rather
// than failing, and so do we, because refusing would stall a fresh chain.
//
// Returns null when nothing usable is supplied, so callers fail closed onto the
// raw stamp rather than medianing to NaN and comparing every barrier against it.
function medianTimePast(previousBlockTimes){
    if(!Array.isArray(previousBlockTimes)) return null;
    let times = previousBlockTimes
                    .map(Number)
                    .filter((t) => Number.isFinite(t) && t > 0);
    if(times.length === 0) return null;
    // Newest MEDIAN_TIME_SPAN first, then median by value. Sorting by value
    // alone would median the wrong set once a caller passes a longer window.
    times.sort((a, b) => b - a);
    let span = times.slice(0, MEDIAN_TIME_SPAN);
    span.sort((a, b) => a - b);
    return span[Math.floor(span.length / 2)];
}

// The instant a block's time-keyed protocol reads and barriers should use.
//
// On an unswitched network, or whenever MTP cannot be computed (genesis, a
// missing window, an unreadable stamp), this is the block's raw timestamp and
// behaviour is byte-identical to before. Otherwise it is MTP, EXCEPT that MTP is
// never allowed to exceed the raw stamp: MTP is a median of older blocks so it
// normally sits well below, but a chain that jumps backwards could invert them,
// and letting protocol time run ahead of the block carrying it would reintroduce
// exactly the future-dated read this exists to remove.
//
// Preserves the caller's `false` sentinel for an unresolvable block_time rather
// than coercing it, because callers distinguish "no such block" from a real 0.
function protocolTime(network, blockTime, previousBlockTimes){
    if(blockTime === false || blockTime === null || blockTime === undefined) return blockTime;
    let raw = Number(blockTime);
    if(!Number.isFinite(raw)) return blockTime;
    if(!isProtocolTimeMtpActive(network)) return raw;
    let mtp = medianTimePast(previousBlockTimes);
    if(mtp === null) return raw;
    return Math.min(mtp, raw);
}

// Stamp resolved protocol time onto the transaction rows for a block.
//
// THIS IS THE HALF THAT MAKES THE REST SAFE. The decoder's block data carries
// `block_time` straight from its own blocks table (the raw stamp), and
// actions.js processTransaction reads `tx.block_time` into data['BLOCK_TIME'],
// which is what every action handler passes to the time-ranged price and oracle
// reads (utility.js reversePriceMatch, reverseOraclePriceMatch, and the fiat
// dispenser window). Moving the mirror barriers to MTP while those rows still
// carried the raw stamp would release a block up to ~2h before wall clock
// reached its own timestamp, and the price window scanned for it would still be
// growing: two nodes reading at different instants credit different amounts.
// That is a FORK, and it is strictly worse than the stall it replaces.
//
// So the rows are re-stamped here, at the one point where the decoder's data
// enters the action path. Mutates in place and returns the row count, since the
// caller has already collapsed output fan-out and must not re-copy the array.
function stampProtocolTime(transactions, resolvedTime){
    if(!Array.isArray(transactions)) return 0;
    if(resolvedTime === false || resolvedTime === null || resolvedTime === undefined) return 0;
    for(let tx of transactions){
        if(tx && typeof tx === 'object') tx.block_time = resolvedTime;
    }
    return transactions.length;
}

module.exports = {
    MEDIAN_TIME_SPAN,
    PROTOCOL_TIME_MTP_NETWORKS,
    isProtocolTimeMtpActive,
    medianTimePast,
    protocolTime,
    stampProtocolTime
};
