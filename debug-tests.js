const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema, resetDecoderDb, resetIndexerDb, closeAll } = require('./test/integration/setup/db-connection');
const DecoderSeeder = require('./test/integration/setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('./test/integration/setup/indexer-launcher');
const helpers = require('./test/integration/setup/assertion-helpers');

const ADDR1 = 'mAddr1XXXXXXXXXXXXXXXXXXXXXXX1';
const ADDR2 = 'mAddr2XXXXXXXXXXXXXXXXXXXXXXX2';
const T0 = 1700000000;
const T_FAR = T0 + 86400 * 365;

async function testOrderCancel() {
    console.log('\n=== ORDER CANCEL DEBUG ===');
    await resetDecoderDb();
    await resetIndexerDb();
    const seeder = new DecoderSeeder(decoderQuery);
    const indexer = await initIndexer();

    await seeder.seedBlock(100, T0, [
        { source: ADDR1, data: 'ISSUE|0|ALPHA|1000|100|0' },
        { source: ADDR2, data: 'ISSUE|0|BETA|1000|100|0' },
    ]);
    await seeder.seedBlock(101, T0 + 600, [
        { source: ADDR1, data: 'MINT|0|ALPHA|100' },
    ]);
    await seeder.seedBlock(102, T0 + 1200, [
        { source: ADDR1, data: 'ORDER|0|BTC|ALPHA|10|BTC|BETA|50|' + ADDR1 + '|' + T_FAR + '|||' },
    ]);
    await processBlocks(indexer);

    const orderIdx = await helpers.getLastActionIndexByType(indexerQuery, 'ORDER');
    console.log('ORDER idx:', orderIdx);

    let bal = await indexerQuery('SELECT a.address, t.tick, b.amount FROM balances b INNER JOIN index_addresses a ON a.id=b.address_id INNER JOIN index_tickers t ON t.id=b.tick_id WHERE a.address=?', [ADDR1]);
    console.log('After ORDER bal:', JSON.stringify(bal));

    let esc = await indexerQuery('SELECT t.tick, e.amount FROM escrows e INNER JOIN index_tickers t ON t.id=e.tick_id');
    console.log('Escrows:', JSON.stringify(esc));

    await seeder.seedBlock(103, T0 + 1800, [
        { source: ADDR1, data: 'ORDER|1|' + orderIdx + '|' },
    ]);
    await processBlocks(indexer);

    let cancelStatus = await indexerQuery('SELECT s.status FROM order_cancels oc INNER JOIN index_statuses s ON s.id=oc.status_id');
    console.log('Cancel status:', JSON.stringify(cancelStatus));

    bal = await indexerQuery('SELECT a.address, t.tick, b.amount FROM balances b INNER JOIN index_addresses a ON a.id=b.address_id INNER JOIN index_tickers t ON t.id=b.tick_id WHERE a.address=?', [ADDR1]);
    console.log('After CANCEL bal:', JSON.stringify(bal));

    esc = await indexerQuery('SELECT t.tick, e.amount FROM escrows e INNER JOIN index_tickers t ON t.id=e.tick_id');
    console.log('Escrows after cancel:', JSON.stringify(esc));

    let cred = await indexerQuery('SELECT t.tick, c.amount, a.address FROM credits c INNER JOIN index_tickers t ON t.id=c.tick_id INNER JOIN index_addresses a ON a.id=c.address_id');
    console.log('All credits:', JSON.stringify(cred));

    await destroyIndexer(indexer);
}

async function run() {
    await createDatabases();
    await createDecoderSchema();
    await testOrderCancel();
    await closeAll();
}
run().catch(e => { console.error(e); process.exit(1); });
