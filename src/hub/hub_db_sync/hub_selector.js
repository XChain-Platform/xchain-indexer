/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { readEnvNow } = require('./env.js');

const DEFAULT_HOSTS = Object.freeze([
    'validator01.xchain.io',
    'validator02.xchain.io',
    'validator03.xchain.io',
    'validator04.xchain.io',
    'validator05.xchain.io'
]);

function defaultUrls(network) {
    let normalized = typeof network === 'string' ? network.trim().toLowerCase() : '';
    let port;
    if(normalized === 'mainnet') port = 10001;
    else if(normalized === 'testnet') port = 10002;
    else {
        let label = normalized || 'unset';
        throw new Error('HUB_SEED_URLS default is unavailable for network "' + label + '"');
    }
    return DEFAULT_HOSTS.map((host) => 'http://' + host + ':' + port);
}

function normalizeUrl(address) {
    if(typeof address !== 'string' || !address.trim())
        throw new Error('Invalid hub URL: expected a non-empty string');

    let parsed;
    try {
        parsed = new URL(address.trim());
    } catch(e) {
        throw new Error('Invalid hub URL "' + address + '"');
    }

    if((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname ||
       parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/')
        throw new Error('Invalid hub URL "' + address + '"');

    return parsed.origin;
}

function unique(addresses) {
    let seen = new Set();
    let result = [];
    for(let address of addresses){
        let normalized = normalizeUrl(address);
        if(seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function parseSeeds(raw, network) {
    if(raw === undefined || raw === null || String(raw).trim() === '') return [];
    let addresses = [];
    for(let item of String(raw).split(',')){
        let value = item.trim();
        if(!value) continue;
        if(value === 'default') addresses.push(...defaultUrls(network));
        else addresses.push(value);
    }
    return unique(addresses);
}

function shuffle(addresses, randomInt) {
    let result = addresses.slice();
    for(let i = result.length - 1; i > 0; i--){
        let j = randomInt(i + 1);
        if(!Number.isInteger(j) || j < 0 || j > i)
            throw new Error('randomInt returned an out-of-range value');
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

function resolveArguments(networkOrOptions, maybeOptions) {
    if(networkOrOptions && typeof networkOrOptions === 'object' && !Array.isArray(networkOrOptions))
        return { network: networkOrOptions.network, options: networkOrOptions };
    return { network: networkOrOptions, options: maybeOptions || {} };
}

function ownOption(options, names, envReader, envKey) {
    for(let name of names){
        if(Object.prototype.hasOwnProperty.call(options, name)) return options[name];
    }
    return envReader(envKey);
}

class HubSelector {
    constructor(networkOrOptions, maybeOptions) {
        let resolved = resolveArguments(networkOrOptions, maybeOptions);
        let options = resolved.options;
        let envReader = options.readEnvNow || options.readEnv || readEnvNow;
        let randomInt = options.randomInt || (options.crypto && options.crypto.randomInt) || crypto.randomInt;
        if(typeof envReader !== 'function') throw new TypeError('readEnvNow must be a function');
        if(typeof randomInt !== 'function') throw new TypeError('randomInt must be a function');

        let rawSeeds = ownOption(options, ['hubSeedUrls', 'seedUrls'], envReader, 'HUB_SEED_URLS');
        let hubApiUrl = ownOption(options, ['hubApiUrl', 'hubUrl'], envReader, 'HUB_API_URL');
        let seeds = parseSeeds(rawSeeds, resolved.network);

        this._randomInt = randomInt;
        this._listeners = new Set();
        this._pinned = seeds.length === 0 && hubApiUrl !== undefined && hubApiUrl !== null &&
            String(hubApiUrl).trim() !== '';
        this._candidates = this._pinned ? [normalizeUrl(String(hubApiUrl))] : shuffle(seeds, randomInt);
        this._index = this._candidates.length ? 0 : -1;
    }

    current() {
        return this._index < 0 ? null : this._candidates[this._index];
    }

    advance(reason) {
        if(this._pinned || this._candidates.length < 2) return this.current();
        let previous = this.current();
        this._index = (this._index + 1) % this._candidates.length;
        let next = this.current();
        for(let listener of Array.from(this._listeners)) listener(next, previous, reason);
        return next;
    }

    merge(addresses) {
        if(!Array.isArray(addresses)) throw new TypeError('Hub addresses must be an array');
        let incoming = unique(addresses);
        if(this._pinned) return this.status();

        let known = new Set(this._candidates);
        let additions = incoming.filter((address) => !known.has(address));
        if(additions.length === 0) return this.status();

        let followed = this.current();
        let remainder = this._candidates.filter((address) => address !== followed).concat(additions);
        remainder = shuffle(remainder, this._randomInt);
        this._candidates = followed === null ? remainder : [followed].concat(remainder);
        this._index = this._candidates.length ? 0 : -1;
        return this.status();
    }

    onChange(fn) {
        if(typeof fn !== 'function') throw new TypeError('Hub selector listener must be a function');
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    status() {
        return {
            current: this.current(),
            candidates: this._candidates.slice(),
            pinned: this._pinned
        };
    }
}

function createHubSelector(networkOrOptions, maybeOptions) {
    return new HubSelector(networkOrOptions, maybeOptions);
}

module.exports = createHubSelector;
module.exports.createHubSelector = createHubSelector;
module.exports.HubSelector = HubSelector;
