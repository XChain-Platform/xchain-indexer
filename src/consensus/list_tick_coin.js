'use strict';

const { CANONICAL_CARET_ID } = require('../db/shared.js');
const { isReservedFutureRoot } = require('./reserved_roots.js');

const LIST_TICK_COIN_SEPARATOR = ':';
const LIST_TICK_COIN_MAX_ITEM_LENGTH = 200;

function coinQualifierRoot(text, coins){
    if(typeof text !== 'string') return null;
    let separator = text.indexOf(LIST_TICK_COIN_SEPARATOR);
    if(separator <= 0) return null;

    let root = text.substring(0, separator).toUpperCase();
    let isCoin = Array.isArray(coins) && coins.some((coin) =>
        typeof coin === 'string' && coin.toUpperCase() === root
    );
    return isCoin || isReservedFutureRoot(root) ? root : null;
}

function parseTickCoinItem(item, coins){
    let coin = coinQualifierRoot(item, coins);
    if(coin === null) return null;

    let separator = item.indexOf(LIST_TICK_COIN_SEPARATOR);
    let rest = item.substring(separator + LIST_TICK_COIN_SEPARATOR.length);
    return {
        coin,
        rest,
        canonical: coin + LIST_TICK_COIN_SEPARATOR + rest,
    };
}

function isTickCoinRestWellFormed(rest, canonical, config){
    if(typeof rest !== 'string' || typeof canonical !== 'string' || !config)
        return false;
    if(canonical.length > LIST_TICK_COIN_MAX_ITEM_LENGTH)
        return false;

    if(rest.startsWith('^'))
        return CANONICAL_CARET_ID.test(rest.substring(1));

    let min = parseInt(config['MIN_TICK_LENGTH']);
    let max = parseInt(config['MAX_TICK_LENGTH']);
    if(rest.length < min || rest.length > max)
        return false;

    let allowed = config['TICK_CHARACTERS'];
    if(typeof allowed !== 'string') return false;
    return rest.split('').every((character) => allowed.includes(character));
}

function ownCoinTickItems(items, coin, coins){
    if(!Array.isArray(items)) return [];
    let ownCoin = typeof coin === 'string' ? coin.toUpperCase() : null;
    let result = [];

    for(let item of items){
        let parsed = parseTickCoinItem(item, coins);
        if(parsed === null){
            result.push({ item, rest: item, qualified: false });
        } else if(parsed.coin === ownCoin){
            result.push({ item, rest: parsed.rest, qualified: true });
        }
    }
    return result;
}

module.exports = {
    LIST_TICK_COIN_SEPARATOR,
    LIST_TICK_COIN_MAX_ITEM_LENGTH,
    coinQualifierRoot,
    parseTickCoinItem,
    isTickCoinRestWellFormed,
    ownCoinTickItems,
};
