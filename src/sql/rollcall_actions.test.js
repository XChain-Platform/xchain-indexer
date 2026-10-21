// Fixture for rollcall_actions (XC-5960). Run: node --test src/sql/rollcall_actions.test.js
// Self-contained: a tiny in-memory stand-in for doQuery, no database or mocha needed.
const test = require('node:test');
const assert = require('node:assert');
const rollcalls = require('../db/rollcalls');

function makeDb(opts){
    opts = opts || {};
    let signers = [];   // {epoch_height, pubkey, action_index, block_index, ledger_hash, publisher, gates}
    let actions = [];
    let hasActions = opts.withTable !== false;
    let db = Object.assign({}, rollcalls, {
        async doQuery(sql, args){
            sql = sql.replace(/\s+/g, ' ').trim();
            if(sql.startsWith('SELECT COUNT(*) AS seen')){
                let epoch = args[0], keys = args.slice(1);
                return [{ seen: signers.filter((s) => s.epoch_height === epoch && keys.includes(s.pubkey)).length }];
            }
            if(sql.startsWith('INSERT IGNORE INTO rollcall_signers')){
                for(let i = 0; i < args.length; i += 8){
                    let [epoch_height, pubkey, , ledger_hash, publisher, action_index, block_index, gates] = args.slice(i, i + 8);
                    if(!signers.some((s) => s.epoch_height === epoch_height && s.pubkey === pubkey))
                        signers.push({ epoch_height, pubkey, ledger_hash, publisher, action_index, block_index, gates });
                }
                return [];
            }
            if(sql.startsWith('INSERT IGNORE INTO rollcall_actions')){
                if(!hasActions) throw new Error('no such table');
                let [action_index, block_index, epoch_height, ledger_hash, publisher, gates, carried_count, first_seen_count] = args;
                if(!actions.some((a) => a.action_index === action_index))
                    actions.push({ action_index, block_index, epoch_height, ledger_hash, publisher, gates, carried_count, first_seen_count });
                return [];
            }
            if(sql.includes('information_schema.TABLES')) return hasActions ? [{ TABLE_NAME: 'rollcall_actions' }] : [];
            if(sql.includes('FROM rollcall_actions')){
                let rows = actions.slice();
                if(sql.includes('WHERE action_index = ?')) rows = rows.filter((a) => a.action_index === args[0]);
                return rows.sort((a, b) => b.action_index - a.action_index).slice(0, args[args.length - 1]);
            }
            if(sql.includes('FROM rollcall_signers')){
                let by = new Map();
                for(let s of signers){
                    if(sql.includes('WHERE action_index = ?') && s.action_index !== args[0]) continue;
                    let g = by.get(s.action_index);
                    if(!g) by.set(s.action_index, g = Object.assign({ carried_count: 0, first_seen_count: 0 }, s));
                    g.carried_count++; g.first_seen_count++;
                }
                return [...by.values()].sort((a, b) => b.action_index - a.action_index)
                    .map(({ pubkey, ...r }) => r);
            }
            throw new Error('unexpected sql: ' + sql);
        }
    });
    return db;
}

const H = 'ab'.repeat(32), PUB1 = '11'.repeat(32), PUB2 = '22'.repeat(32);
const sig = (pubkey, extra) => Object.assign({ epoch_height: 800000, pubkey, sig: 'cd'.repeat(32),
    ledger_hash: H, publisher: PUB1, action_index: 10, block_index: 500, gates: null }, extra);
const act = (action_index, block_index, gates) => ({ action_index, block_index, epoch_height: 800000,
    ledger_hash: H, publisher: PUB1, gates });

async function twoActions(db){
    await db.insertRollcallSigners([sig('aa'.repeat(32)), sig('bb'.repeat(32))], act(10, 500, 'g1'));
    // second action: only already-seen pubkeys, so no signer row lands
    await db.insertRollcallSigners(
        [sig('aa'.repeat(32), { action_index: 11, block_index: 501, publisher: PUB2, gates: 'g2' })],
        act(11, 501, 'g2'));
}

test('both actions are listed with epoch, ledger_hash, publisher, gates and split counts', async () => {
    let db = makeDb();
    await db.insertRollcallSigners([sig('aa'.repeat(32)), sig('bb'.repeat(32))], act(10, 500, 'g1'));
    await db.insertRollcallSigners([sig('aa'.repeat(32), { action_index: 11, block_index: 501 })],
        Object.assign(act(11, 501, 'g2'), { publisher: PUB2 }));
    let list = await db.getRollcallActions(20);
    assert.deepStrictEqual(list.map((r) => r.action_index), [11, 10]);
    let [second, first] = list;
    assert.deepStrictEqual(first, { action_index: 10, block_index: 500, epoch_height: 800000, ledger_hash: H,
        publisher: PUB1, gates: 'g1', carried_count: 2, first_seen_count: 2 });
    assert.deepStrictEqual(second, { action_index: 11, block_index: 501, epoch_height: 800000, ledger_hash: H,
        publisher: PUB2, gates: 'g2', carried_count: 1, first_seen_count: 0 });
});

test('detail read for the second action returns its own fields', async () => {
    let db = makeDb();
    await twoActions(db);
    let rows = await db.getRollcallActions(1, 11);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].carried_count, 1);
    assert.strictEqual(rows[0].first_seen_count, 0);
    assert.strictEqual(rows[0].gates, 'g2');
});

test('replaying a block does not double-write the action row', async () => {
    let db = makeDb();
    await twoActions(db);
    await twoActions(db);
    assert.strictEqual((await db.getRollcallActions(20)).length, 2);
});

test('replica without rollcall_actions falls back to rollcall_signers (de-blank baseline)', async () => {
    let db = makeDb({ withTable: false });
    await db.insertRollcallSigners([sig('aa'.repeat(32)), sig('bb'.repeat(32))]);  // legacy call, no action
    let list = await db.getRollcallActions(20);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].action_index, 10);
    assert.strictEqual(list[0].epoch_height, 800000);
    assert.strictEqual(list[0].ledger_hash, H);
    assert.strictEqual(list[0].carried_count, 2);
    assert.strictEqual(list[0].first_seen_count, 2);
});
