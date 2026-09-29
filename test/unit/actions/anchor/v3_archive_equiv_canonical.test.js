'use strict';

const assert = require('assert');

const Anchor = require('../../../../src/actions/anchor/index.js');

function section(){
    return {
        FORMAT: 0,
        SECTION_INDEX: 0,
        NETWORK: 'regtest',
        CHAIN: 'BTC',
        BLOCK_INDEX_CHECKPOINTED: '100007',
        BLOCK_HASH: 'a'.repeat(64),
        LEDGER_HASH: 'b'.repeat(64),
        ACTIONS_HASH: 'c'.repeat(64),
        CONTRACT_HASH: 'd'.repeat(64),
        CHECKPOINT_SEQ: '7',
        SNAPSHOT_BLOCK: '41647',
        STATE_ROOT: 'e'.repeat(64),
        STATE_ROOT_VERSION: '1',
        BLOCK_MERKLE_ROOT: 'f'.repeat(64),
        BLOCK_MERKLE_VERSION: '1',
        FOLD_ARCHIVE: {
            WRAPPER_SECTION_INDEX: '0',
            MATCH_BATCH_SEQ: '5',
            MATCH_COUNT: '1',
            BATCH_CRC32: '8665563e',
            TOTAL_CHUNKS: '1',
        },
    };
}

describe('ANCHOR v3 archive equivocation canonical', function () {
    it('matches the hub canonical exactly for an archive wrapper section', function () {
        const expected = 'EQUIV|XCHECKPOINT|BTC|regtest|100007|7|5|0||XCHECKPOINT|BTC|regtest|100007|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc|dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd|7|41647|eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee|1|ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff|1|5|1|8665563e|1';

        assert.strictEqual(Anchor.prototype.canonical.call({}, section()), expected);
        assert.strictEqual(expected.length, 491);
    });

    it('keeps the plain section round id free of a batch sequence', function () {
        const plain = section();
        delete plain.FOLD_ARCHIVE;

        const canonical = Anchor.prototype.canonical.call({}, plain);
        assert.ok(canonical.startsWith('EQUIV|XCHECKPOINT|BTC|regtest|100007|7|0||'));
    });

    it('appends the archive batch sequence once to a FORMAT 1 round id', function () {
        const archiveHead = section();
        archiveHead.FORMAT = 1;
        archiveHead.MATCH_BATCH_SEQ = archiveHead.FOLD_ARCHIVE.MATCH_BATCH_SEQ;
        archiveHead.MATCH_COUNT = archiveHead.FOLD_ARCHIVE.MATCH_COUNT;
        archiveHead.BATCH_CRC32 = archiveHead.FOLD_ARCHIVE.BATCH_CRC32;
        archiveHead.TOTAL_CHUNKS = archiveHead.FOLD_ARCHIVE.TOTAL_CHUNKS;

        const canonical = Anchor.prototype.canonical.call({}, archiveHead);
        assert.ok(canonical.startsWith('EQUIV|XCHECKPOINT|BTC|regtest|100007|7|5|0||'));
        assert.strictEqual(canonical.split('||', 1)[0],
            'EQUIV|XCHECKPOINT|BTC|regtest|100007|7|5|0');
    });
});
