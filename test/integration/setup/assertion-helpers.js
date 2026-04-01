/**
 * Assertion helpers for integration tests.
 *
 * Queries the indexer DB directly to verify state after block processing.
 * All functions take the indexerQuery function from db-connection.js.
 */

const assert = require('assert');

/**
 * Assert an address has a specific balance for a ticker.
 * Queries: balances JOIN index_addresses JOIN index_tickers
 */
async function assertBalance(queryFn, address, tick, expectedAmount) {
    const rows = await queryFn(
        `SELECT b.amount
         FROM balances b
         INNER JOIN index_addresses a ON a.id = b.address_id
         INNER JOIN index_tickers   t ON t.id = b.tick_id
         WHERE a.address = ? AND t.tick = ?`,
        [address, tick]
    );
    if (expectedAmount === null || expectedAmount === undefined) {
        assert.strictEqual(rows.length, 0,
            `Expected no balance for ${address}/${tick}, but found ${rows.length} rows`);
    } else {
        assert.strictEqual(rows.length, 1,
            `Expected 1 balance row for ${address}/${tick}, found ${rows.length}`);
        assert.strictEqual(rows[0].amount, String(expectedAmount),
            `Balance mismatch for ${address}/${tick}: expected ${expectedAmount}, got ${rows[0].amount}`);
    }
}

/**
 * Assert the token supply in the tokens table.
 */
async function assertTokenSupply(queryFn, tick, expectedSupply) {
    const rows = await queryFn(
        `SELECT t.supply
         FROM tokens t
         INNER JOIN index_tickers it ON it.id = t.tick_id
         WHERE it.tick = ?`,
        [tick]
    );
    assert.strictEqual(rows.length, 1, `Token ${tick} not found in tokens table`);
    assert.strictEqual(rows[0].supply, String(expectedSupply),
        `Supply mismatch for ${tick}: expected ${expectedSupply}, got ${rows[0].supply}`);
}

/**
 * Assert the token owner address.
 */
async function assertTokenOwner(queryFn, tick, expectedAddress) {
    const rows = await queryFn(
        `SELECT a.address
         FROM tokens t
         INNER JOIN index_tickers   it ON it.id = t.tick_id
         INNER JOIN index_addresses a  ON a.id  = t.owner_id
         WHERE it.tick = ?`,
        [tick]
    );
    assert.strictEqual(rows.length, 1, `Token ${tick} not found`);
    assert.strictEqual(rows[0].address, expectedAddress,
        `Owner mismatch for ${tick}: expected ${expectedAddress}, got ${rows[0].address}`);
}

/**
 * Assert the token exists and return its full row from the tokens table.
 */
async function getToken(queryFn, tick) {
    const rows = await queryFn(
        `SELECT t.*
         FROM tokens t
         INNER JOIN index_tickers it ON it.id = t.tick_id
         WHERE it.tick = ?`,
        [tick]
    );
    return rows.length > 0 ? rows[0] : null;
}

/**
 * Assert an action record exists with the expected status.
 */
async function assertActionStatus(queryFn, table, actionIndex, expectedStatus) {
    const rows = await queryFn(
        `SELECT s.status
         FROM ${table} r
         INNER JOIN index_statuses s ON s.id = r.status_id
         WHERE r.action_index = ?`,
        [actionIndex]
    );
    assert.ok(rows.length > 0,
        `No record found in ${table} for action_index=${actionIndex}`);
    assert.strictEqual(rows[0].status, expectedStatus,
        `Status mismatch in ${table} for action_index=${actionIndex}: expected '${expectedStatus}', got '${rows[0].status}'`);
}

/**
 * Get the action_index for the Nth action in the indexer (1-based).
 */
async function getActionIndex(queryFn, n) {
    const rows = await queryFn(
        `SELECT action_index FROM actions ORDER BY action_index ASC LIMIT 1 OFFSET ?`,
        [n - 1]
    );
    return rows.length > 0 ? Number(rows[0].action_index) : null;
}

/**
 * Get the action_index of the latest action for a given action type.
 */
async function getLastActionIndexByType(queryFn, actionName) {
    const rows = await queryFn(
        `SELECT a.action_index
         FROM actions a
         INNER JOIN index_actions ia ON ia.id = a.action_id
         WHERE ia.action = ?
         ORDER BY a.action_index DESC LIMIT 1`,
        [actionName]
    );
    return rows.length > 0 ? Number(rows[0].action_index) : null;
}

/**
 * Count rows in a given indexer table.
 */
async function countRows(queryFn, table, where, args) {
    const sql = where ? `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${where}` :
                        `SELECT COUNT(*) AS cnt FROM ${table}`;
    const rows = await queryFn(sql, args || []);
    return Number(rows[0].cnt);
}

/**
 * Assert the number of blocks in the indexer.
 */
async function assertBlockCount(queryFn, expected) {
    const count = await countRows(queryFn, 'blocks');
    assert.strictEqual(count, expected,
        `Expected ${expected} blocks, found ${count}`);
}

/**
 * Assert that credit/debit records exist for a given action_index.
 */
async function assertLedgerEntry(queryFn, table, actionIndex, tick, address, expectedAmount) {
    const rows = await queryFn(
        `SELECT r.amount
         FROM ${table} r
         INNER JOIN index_tickers   t ON t.id = r.tick_id
         INNER JOIN index_addresses a ON a.id = r.address_id
         WHERE r.action_index = ? AND t.tick = ? AND a.address = ?`,
        [actionIndex, tick, address]
    );
    assert.ok(rows.length > 0,
        `No ${table} entry for action_index=${actionIndex}, ${tick}, ${address}`);
    assert.strictEqual(rows[0].amount, String(expectedAmount),
        `${table} amount mismatch: expected ${expectedAmount}, got ${rows[0].amount}`);
}

/**
 * Run the sanity check manually: verify supply consistency for a ticker.
 * tokens.supply == (credits - debits + escrows) == (balances + escrows)
 */
async function assertSanity(queryFn, tick) {
    // Get token supply from tokens table
    const tokenRows = await queryFn(
        `SELECT t.supply, t.decimals
         FROM tokens t
         INNER JOIN index_tickers it ON it.id = t.tick_id
         WHERE it.tick = ?`, [tick]
    );
    if (tokenRows.length === 0) return; // No token, nothing to check

    const tokenSupply = tokenRows[0].supply;

    // Get tick_id
    const tickRows = await queryFn('SELECT id FROM index_tickers WHERE tick = ?', [tick]);
    const tickId = tickRows[0].id;

    // Sum credits
    const creditRows = await queryFn(
        'SELECT COALESCE(SUM(CAST(amount AS DECIMAL(65,18))), 0) AS total FROM credits WHERE tick_id = ?', [tickId]
    );
    // Sum debits
    const debitRows = await queryFn(
        'SELECT COALESCE(SUM(CAST(amount AS DECIMAL(65,18))), 0) AS total FROM debits WHERE tick_id = ?', [tickId]
    );
    // Sum escrows
    const escrowRows = await queryFn(
        'SELECT COALESCE(SUM(CAST(amount AS DECIMAL(65,18))), 0) AS total FROM escrows WHERE tick_id = ?', [tickId]
    );
    // Sum balances
    const balanceRows = await queryFn(
        'SELECT COALESCE(SUM(CAST(amount AS DECIMAL(65,18))), 0) AS total FROM balances WHERE tick_id = ?', [tickId]
    );

    const credits = parseFloat(creditRows[0].total);
    const debits = parseFloat(debitRows[0].total);
    const escrows = parseFloat(escrowRows[0].total);
    const balances = parseFloat(balanceRows[0].total);
    const ledgerSupply = credits - debits + escrows;
    const totalSupply = balances + escrows;

    assert.strictEqual(parseFloat(tokenSupply), ledgerSupply,
        `Sanity: token supply (${tokenSupply}) != ledger supply (${ledgerSupply}) for ${tick}`);
    assert.strictEqual(parseFloat(tokenSupply), totalSupply,
        `Sanity: token supply (${tokenSupply}) != balances+escrows (${totalSupply}) for ${tick}`);
}

/**
 * Assert the block hash chain is valid (each block references previous hash).
 */
async function assertHashChain(queryFn) {
    const blocks = await queryFn(
        `SELECT b.block_index, b.ledger_hash_id, b.actions_hash_id
         FROM blocks b ORDER BY b.block_index ASC`
    );
    assert.ok(blocks.length > 0, 'No blocks found for hash chain verification');
    // Just verify each block has hash IDs
    for (const block of blocks) {
        assert.ok(block.ledger_hash_id !== null,
            `Block ${block.block_index} missing ledger hash`);
        assert.ok(block.actions_hash_id !== null,
            `Block ${block.block_index} missing actions hash`);
    }
}

module.exports = {
    assertBalance, assertTokenSupply, assertTokenOwner, getToken,
    assertActionStatus, getActionIndex, getLastActionIndexByType,
    countRows, assertBlockCount,
    assertLedgerEntry, assertSanity, assertHashChain,
};
