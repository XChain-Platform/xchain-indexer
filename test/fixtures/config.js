/**
 * Test configuration fixture — loads real BTC regtest config
 * without requiring any environment variables beyond INDEXER_COIN/INDEXER_NETWORK
 */

function getTestConfig() {
    // Set environment for config loading
    process.env.INDEXER_COIN = 'BTC';
    process.env.INDEXER_NETWORK = 'regtest';

    const config = require('../../src/config.js');
    return config.getConfig();
}

module.exports = { getTestConfig };
