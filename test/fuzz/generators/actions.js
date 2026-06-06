/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * fast-check arbitraries for ACTION data strings and complete transaction objects.
 *
 * Builds grammar-based generators matching the pipe-delimited format
 * used by xchain-indexer's processTransaction().
 */

const fc = require('fast-check');
const { validAmount, anyAmount } = require('./amounts');
const { validTick, anyTick } = require('./ticks');
const { cryptoAddress, anyAddress, txHash } = require('./addresses');

const KNOWN_ACTIONS = [
    'ADDRESS', 'AIRDROP', 'BATCH', 'BROADCAST', 'CALLBACK', 'DESTROY',
    'DISPENSER', 'DIVIDEND', 'FILE', 'ISSUE', 'LINK', 'LIST', 'MESSAGE',
    'MINT', 'ORDER', 'SEND', 'SLEEP', 'SWAP', 'SWEEP',
];

const ACTION_ALIASES = ['DEPLOY', 'TRANSFER', 'ADDR', 'DROP', 'CAST', 'MSG'];

/**
 * Generate a well-formed ISSUE|0|... data string with fuzzed field values.
 */
function issueDataString() {
    return fc.tuple(
        anyTick(),
        anyAmount(),                              // MAX_SUPPLY
        anyAmount(),                              // MAX_MINT
        fc.integer({ min: 0, max: 18 }).map(String), // DECIMALS
        fc.string({ minLength: 0, maxLength: 50 }),   // DESCRIPTION
    ).map(([tick, maxSupply, maxMint, decimals, desc]) =>
        `ISSUE|0|${tick}|${maxSupply}|${maxMint}|${decimals}|${desc}`
    );
}

/**
 * Generate a well-formed SEND|0|... data string with fuzzed field values.
 */
function sendDataString() {
    return fc.tuple(
        anyTick(),
        anyAmount(),
        anyAddress(),
        fc.string({ minLength: 0, maxLength: 30 }),  // MEMO
    ).map(([tick, amount, dest, memo]) =>
        `SEND|0|${tick}|${amount}|${dest}|${memo}`
    );
}

/**
 * Generate a well-formed MINT|0|... data string.
 */
function mintDataString() {
    return fc.tuple(
        anyTick(),
        anyAmount(),
        anyAddress(),
        fc.string({ minLength: 0, maxLength: 30 }),
    ).map(([tick, amount, dest, memo]) =>
        `MINT|0|${tick}|${amount}|${dest}|${memo}`
    );
}

/**
 * Generate a BATCH|0|cmd1;cmd2 data string with 1–10 sub-commands.
 */
function batchDataString() {
    const subCommand = fc.oneof(
        issueDataString().map(s => s),  // includes ISSUE|0|...
        sendDataString().map(s => s),
        mintDataString().map(s => s),
    );
    return fc.array(subCommand, { minLength: 1, maxLength: 10 })
        .map(cmds => 'BATCH|0|' + cmds.join(';'));
}

/**
 * Take a valid-ish data string and apply a random mutation.
 */
function mutatedDataString() {
    const base = fc.oneof(issueDataString(), sendDataString(), mintDataString());
    const mutation = fc.constantFrom(
        'duplicate_pipe',
        'remove_field',
        'insert_null_byte',
        'replace_field_random',
        'reverse',
        'empty_fields',
        'extra_pipes',
    );
    return fc.tuple(base, mutation, fc.string({ minLength: 0, maxLength: 20 }))
        .map(([str, mut, rnd]) => {
            const parts = str.split('|');
            switch (mut) {
                case 'duplicate_pipe':
                    return str.replace('|', '||');
                case 'remove_field':
                    if (parts.length > 2) parts.splice(2, 1);
                    return parts.join('|');
                case 'insert_null_byte':
                    return str.slice(0, 5) + '\x00' + str.slice(5);
                case 'replace_field_random':
                    if (parts.length > 2) parts[2] = rnd;
                    return parts.join('|');
                case 'reverse':
                    return str.split('').reverse().join('');
                case 'empty_fields':
                    return parts.map(() => '').join('|');
                case 'extra_pipes':
                    return str + '||||';
                default:
                    return str;
            }
        });
}

/**
 * Generate an unknown action data string.
 */
function unknownActionString() {
    return fc.tuple(
        fc.array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')), { minLength: 3, maxLength: 10 })
            .map(a => a.join(''))
            .filter(s => !KNOWN_ACTIONS.includes(s) && !ACTION_ALIASES.includes(s)),
        fc.string({ minLength: 0, maxLength: 50 }),
    ).map(([action, rest]) => `${action}|0|${rest}`);
}

/**
 * Wrap any data-string arbitrary into a complete tx object for processTransaction().
 */
function fuzzedTx(dataArb) {
    if (!dataArb) dataArb = fc.oneof(
        issueDataString(),
        sendDataString(),
        mintDataString(),
        batchDataString(),
        mutatedDataString(),
        unknownActionString(),
        fc.string({ minLength: 0, maxLength: 200 }),
    );
    return fc.tuple(
        dataArb,
        cryptoAddress(),
        fc.oneof(cryptoAddress(), fc.constant(null)),
        fc.oneof(fc.constantFrom('0', '0.001', '1.5'), fc.string({ minLength: 1, maxLength: 10 })),
        txHash(),
        fc.integer({ min: 1, max: 999999 }),
        fc.integer({ min: 1000000000, max: 2000000000 }),
        fc.integer({ min: 0, max: 10 }),
    ).map(([data, source, destination, amount, hash, blockIndex, blockTime, vout]) => ({
        data,
        source,
        destination,
        amount,
        tx_hash: hash,
        block_index: blockIndex,
        block_time: blockTime,
        vout,
    }));
}

module.exports = {
    KNOWN_ACTIONS,
    ACTION_ALIASES,
    issueDataString,
    sendDataString,
    mintDataString,
    batchDataString,
    mutatedDataString,
    unknownActionString,
    fuzzedTx,
};
