'use strict';

const gateRegistry = require('../../consensus/gate_registry');
const { isBridgeMirrorLeg, classifyTickItem } = require('./tick_coin_rules.js');

const LIST_TICK_COIN_KEY = 'list_tick_coin_activation.LIST_TICK_COIN_ACTIVATION';

async function lookupTick(item){
    let status = 'valid';
    let tokenInfo = await this.indexerDb.getTokenInfo(item);
    if(!tokenInfo) status = 'invalid: TICK (unknown)';
    return { item, status };
}

module.exports = {
    async checkTickItem(item, data){
        if(!gateRegistry.activeAt(LIST_TICK_COIN_KEY, this.config['NETWORK'],
            this.config['COIN'], data['BLOCK_INDEX'], null))
            return lookupTick.call(this, item);

        let classified = classifyTickItem(item, {
            coin: this.config['COIN'],
            coins: this.config['COINS'],
            config: this.config,
            mirrorLeg: isBridgeMirrorLeg(data, this.config),
        });
        item = classified.item;

        if(classified.path === 'format')
            return { item, status: 'invalid: TICK (format)' };
        if(classified.path === 'valid')
            return { item, status: 'valid' };
        return lookupTick.call(this, item);
    },
};
