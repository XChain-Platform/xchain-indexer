'use strict';

const { ARCHIVE_REWARD_TYPE } = require('./anchor_reward_key.js');

function rewardTypeFor(format, foldActive){
    const numericFormat = typeof format === 'number' ||
        (typeof format === 'string' && format.trim() !== '') ? Number(format) : NaN;
    if(numericFormat === 1) return foldActive ? null : ARCHIVE_REWARD_TYPE;
    if(numericFormat === 0 || numericFormat === 3) return 'anchor_bundle';
    return null;
}

module.exports = { rewardTypeFor };
