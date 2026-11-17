'use strict';

const assert = require('assert');
const ProtocolChanges = require('../../../src/protocol_changes.js');
const constants = require('../../../src/protocol/constants.js');
const changes = require('../../../src/protocol_changes/changes_5.js');
const { FILE_MULTIPART_TESTNET_TIME } = require('../../../src/protocol_changes/flag_times.js');

const ENV = 'FILE_MULTIPART_REGTEST_TIME';
const KEY = 'protocol_changes.changes.FILE_MULTIPART';

function build(network, time) {
    return new ProtocolChanges({
        config: { NETWORK: network },
        util: {},
        decoderDb: { getBlockTime: async () => time },
    });
}

describe('protocol_changes FILE_MULTIPART row @regression @tier1', function () {
    const saved = process.env[ENV];

    beforeEach(function () {
        delete process.env[ENV];
    });

    after(function () {
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
    });

    it('is the final part 5 row with the specified activation table', function () {
        const entry = changes[changes.length - 1];
        const table = new ProtocolChanges({ config: {}, util: {} }).changes.FILE_MULTIPART;

        assert.strictEqual(entry[0], 'FILE_MULTIPART');
        assert.strictEqual(entry[1], '0.2.0');
        assert.strictEqual(entry[2], ProtocolChanges.UNARMED);
        assert.strictEqual(entry[3], 1794787200);
        assert.strictEqual(entry[4](), 0);
        assert.deepStrictEqual(entry.slice(5), [0, 0, 0]);
        assert.strictEqual(FILE_MULTIPART_TESTNET_TIME, 1794787200);
        assert.deepStrictEqual(table, ProtocolChanges.get(KEY));
    });

    it('is dark on mainnet, activates at the testnet instant, and is active at regtest genesis', async function () {
        assert.strictEqual(await build('mainnet', ProtocolChanges.UNARMED - 1).isEnabled('FILE_MULTIPART', 0), false);
        assert.strictEqual(await build('testnet', FILE_MULTIPART_TESTNET_TIME - 1).isEnabled('FILE_MULTIPART', 0), false);
        assert.strictEqual(await build('testnet', FILE_MULTIPART_TESTNET_TIME).isEnabled('FILE_MULTIPART', 0), true);
        assert.strictEqual(await build('regtest', 0).isEnabled('FILE_MULTIPART', 0), true);
    });

    it('publishes both multipart caps through registry copies', function () {
        assert.strictEqual(ProtocolChanges.get('protocol/constants.MULTIPART_FILE_MAX_PARTS'), 65535);
        assert.strictEqual(ProtocolChanges.get('protocol/constants.MULTIPART_FILE_MAX_BYTES'), 262140000000);
        assert.strictEqual(constants.MULTIPART_FILE_MAX_PARTS, 65535);
        assert.strictEqual(constants.MULTIPART_FILE_MAX_BYTES, 262140000000);
    });
});
