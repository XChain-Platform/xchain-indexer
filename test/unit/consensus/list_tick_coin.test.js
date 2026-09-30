'use strict';

const assert = require('assert');

const {
    LIST_TICK_COIN_SEPARATOR,
    LIST_TICK_COIN_MAX_ITEM_LENGTH,
    coinQualifierRoot,
    parseTickCoinItem,
    isTickCoinRestWellFormed,
    ownCoinTickItems,
} = require('../../../src/consensus/list_tick_coin.js');

const COINS = ['BTC', 'LTC', 'DOGE'];
const CONFIG = {
    MIN_TICK_LENGTH: 1,
    MAX_TICK_LENGTH: 250,
    TICK_CHARACTERS: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789~!@#$%^&*()_+-={}[]:<>.?',
};

describe('coin-qualified LIST ticker items', function(){
    it('exports the canonical separator and storage-bound length', function(){
        assert.strictEqual(LIST_TICK_COIN_SEPARATOR, ':');
        assert.strictEqual(LIST_TICK_COIN_MAX_ITEM_LENGTH, 200);
    });

    it('recognizes configured coins and reserved future roots case-insensitively', function(){
        assert.strictEqual(coinQualifierRoot('DOGE:PEPE', COINS), 'DOGE');
        assert.strictEqual(coinQualifierRoot('doge:^12', COINS), 'DOGE');
        assert.strictEqual(coinQualifierRoot('ETH:FOO', COINS), 'ETH');
    });

    it('leaves non-qualifying items bare', function(){
        for(let item of [':PEPE', 'FOO:BAR', 'PEPE', '^12', 'XCHAIN:FOO']){
            assert.strictEqual(coinQualifierRoot(item, COINS), null, item);
            assert.strictEqual(parseTickCoinItem(item, COINS), null, item);
        }
    });

    it('canonicalizes the root and preserves the rest exactly', function(){
        assert.deepStrictEqual(parseTickCoinItem('doge:^12', COINS), {
            coin: 'DOGE',
            rest: '^12',
            canonical: 'DOGE:^12',
        });
        assert.deepStrictEqual(parseTickCoinItem('DOGE:A:B', COINS), {
            coin: 'DOGE',
            rest: 'A:B',
            canonical: 'DOGE:A:B',
        });
    });

    it('accepts canonical ids and configured ticker names', function(){
        for(let item of ['doge:^12', 'DOGE:PEPE', 'DOGE:A:B', 'DOGE:' + 'A'.repeat(195)]){
            let parsed = parseTickCoinItem(item, COINS);
            assert.strictEqual(
                isTickCoinRestWellFormed(parsed.rest, parsed.canonical, CONFIG),
                true,
                item
            );
        }
    });

    it('rejects noncanonical ids, an empty rest and a canonical item over 200 characters', function(){
        for(let item of ['DOGE:^012', 'DOGE:^0', 'DOGE:', 'DOGE:' + 'A'.repeat(196)]){
            let parsed = parseTickCoinItem(item, COINS);
            assert.strictEqual(
                isTickCoinRestWellFormed(parsed.rest, parsed.canonical, CONFIG),
                false,
                item
            );
        }
    });

    it('keeps bare and own-coin items in input order', function(){
        assert.deepStrictEqual(
            ownCoinTickItems(['FOO', 'BTC:^5', 'DOGE:PEPE', 'btc:BAR', 'ETH:X'], 'BTC', COINS),
            [
                { item: 'FOO', rest: 'FOO', qualified: false },
                { item: 'BTC:^5', rest: '^5', qualified: true },
                { item: 'btc:BAR', rest: 'BAR', qualified: true },
            ]
        );
    });
});
