/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - Genesis Mixin: Protocol Token Row Creation
 *
 * The shared "create or read one token row" primitives both the BTC genesis
 * pass (injectGasToken) and a bridge settle leg (bridged_token.js) build on, so
 * XCHAIN and every bridged row are created through ONE code path. Installed
 * onto Genesis.prototype by ../genesis.js, so call sites stay
 * this.injectProtocolToken() etc.
 *
 ********************************************************************/

const crypto = require('crypto');

const { getLogger } = require('../../observability/index.js');

module.exports = {

    // Inject the XCHAIN gas token as the first genesis action. Unlike the bare name
    // reservations, the gas token carries real parameters: 8 decimals and a 100,000,000
    // MAX_SUPPLY, owned by GAS, with zero pre-mint (supply 0). MINT_START_BLOCK is pinned to a
    // far-future sentinel so the token exists but is un-mintable until the operator lowers it
    // via a later GAS-signed ISSUE (the launch open-mint). Decimals stay editable until the
    // first mint (issue.js locks them only once SUPPLY > 0), so the launch ISSUE can still
    // tune caps/window while supply is 0. The synthetic tx hash uses a distinct GAS marker so
    // it never collides with the per-name create/transfer passes.
    async injectGasToken(gas, blockToParse, blockTime){
        let tick = this.config['GAS']; // 'XCHAIN'
        // Routed through the shared creation helper so the BTC genesis row and the row the
        // bridge creates off BTC come out of ONE code path:
        // two independent paths would drift, and a drifted parameter is a different token row
        // on two chains, which is a different ledger hash. The parameter set is the same
        // object the bridge passes, so "byte-identical" is a fact of the code, not a promise.
        // The synthesized transaction (data string, tx hash, source, vout) is byte-identical
        // to the pre-refactor one; test/unit/chain/genesis_bridge_replay_pin.test.js pins both
        // literals, so genesis replays to the same hashes on every chain.
        // skipExistsProbe: the genesis pass runs once, at a block-keyed height, and this is the
        // FIRST action of that block, so the row provably cannot be there yet. The probe the
        // bridge needs (many in-legs, one row) would only add a read to the one block whose
        // replay every node has to reproduce, so genesis keeps the read it never had.
        getLogger().info('GENESIS: injecting gas token ' + tick + ' (decimals 8, max_supply 100000000, mint disabled) owned by GAS');
        await this.injectProtocolToken(this.gasTokenParams(gas), {
            blockIndex:      blockToParse,
            blockTime:       blockTime,
            txHashPrefix:    'GENESIS-',
            skipExistsProbe: true
        });
    },

    /**
     * The gas token parameter set, in one place, for both creation sites: this chain's
     * genesis pass on BTC mainnet and the bridge's first XBRIDGE v2 in-leg on DOGE/LTC.
     * Callers MUST NOT retype these values (the XCHAIN call site passes the
     * byte-identical set, and that is a hard obligation, not a preference).
     *
     * @param {string} [owner] - the owning address; defaults to this chain's ADDRESS.GAS
     * @returns {Object} the injectProtocolToken parameter set for XCHAIN
     */
    gasTokenParams(owner){
        return {
            tick:           this.config['GAS'],
            owner:          this.util.isNull(owner) ? this.config['ADDRESS']['GAS'] : owner,
            maxSupply:      '100000000',
            decimals:       '8',
            lockMaxSupply:  '',                 // never locked: the launch ISSUE still tunes the cap
            mintStartBlock: '999999999',        // sentinel: mint disabled until the operator lowers it
            mintSupply:     '',                 // no pre-mint
            description:    'XChain gas token',
            locks:          {}
        };
    },

    /**
     * Build the ISSUE format 0 field list for a parameter set. The field ORDER is
     * issue.js formats[0] and is consensus: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|
     * DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|
     * LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|
     * CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|
     * MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO.
     *
     * TRAILING EMPTY FIELDS ARE TRIMMED, and that trim is what keeps the gas token's wire
     * string byte-identical: the gas set touches nothing past MINT_START_BLOCK, so the three
     * later fields a bridged row needs (LOCK_MINT and LOCK_MINT_SUPPLY, and the
     * MINT_STOP_BLOCK placeholder between them) disappear from its data string exactly as
     * they did before this helper existed. The parser tolerates a short field list.
     *
     * There is never a TRANSFER: every injected row is created owned by its final owner.
     *
     * @param {Object} params - see injectProtocolToken
     * @returns {string[]} the field list, ready to join with '|'
     */
    issueFields(params){
        let locks = params.locks || {};
        let v     = (x) => this.util.isNull(x) ? '' : String(x);
        let fields = [
            'ISSUE',
            '0',
            String(params.tick),
            v(params.maxSupply),             // MAX_SUPPLY (empty = uncapped sentinel)
            '',                              // MAX_MINT (no per-tx cap)
            v(params.decimals),              // DECIMALS
            v(params.description),           // DESCRIPTION
            v(params.mintSupply),            // MINT_SUPPLY
            '',                              // TRANSFER (owner is the SOURCE)
            '',                              // TRANSFER_SUPPLY
            v(params.lockMaxSupply),         // LOCK_MAX_SUPPLY
            v(locks['LOCK_MAX_MINT']),       // LOCK_MAX_MINT
            v(locks['LOCK_DESCRIPTION']),    // LOCK_DESCRIPTION
            v(locks['LOCK_SLEEP']),          // LOCK_SLEEP
            v(locks['LOCK_CALLBACK']),       // LOCK_CALLBACK
            '',                              // CALLBACK_BLOCK
            '',                              // CALLBACK_TICK
            '',                              // CALLBACK_AMOUNT
            '',                              // ALLOW_LIST
            '',                              // BLOCK_LIST
            '',                              // MINT_ADDRESS_MAX
            v(params.mintStartBlock),        // MINT_START_BLOCK
            '',                              // MINT_STOP_BLOCK
            v(locks['LOCK_MINT']),           // LOCK_MINT
            v(locks['LOCK_MINT_SUPPLY'])     // LOCK_MINT_SUPPLY
        ];
        while(fields.length > 3 && fields[fields.length - 1] === '')
            fields.pop();
        return fields;
    },

    /**
     * Wrap a field list in the synthetic transaction the injected passes use. The tx hash is
     * deterministic so a reindex replays to identical action indexes and hashes.
     *
     * HASH SHAPE: <txHashPrefix><COIN>-<family>-<48 hex of sha256(COIN|family|tick[|salt])>.
     * The gas token's family is 'GAS' and it carries no salt, which is exactly the
     * pre-refactor preimage and prefix, so its hash does not move. `family` separates the
     * synthetic transaction families so an injected row can never collide with another
     * pass's hash; `salt` distinguishes two injections for the SAME tick in the same family
     * (the decimals re-parameterization below, where the new precision is the salt).
     *
     * @param {string[]} fields - from issueFields
     * @param {string} tick     - the tick, which is the hash preimage's identity component
     * @param {string} source   - the injecting address
     * @param {Object} ctx      - { blockIndex, blockTime, txHashPrefix, txHashFamily, txHashSalt }
     * @returns {Object} the synthetic transaction
     */
    syntheticIssueTx(fields, tick, source, ctx){
        let prefix = this.util.isNull(ctx.txHashPrefix) ? 'GENESIS-' : String(ctx.txHashPrefix);
        let family = this.util.isNull(ctx.txHashFamily) ? 'GAS'      : String(ctx.txHashFamily);
        let salt   = this.util.isNull(ctx.txHashSalt)   ? ''         : '|' + String(ctx.txHashSalt);
        let digest = crypto.createHash('sha256')
            .update(this.config['COIN'] + '|' + family + '|' + tick + salt).digest('hex').slice(0, 48);
        return {
            data:          fields.join('|'),
            source:        source,
            destination:   null,
            amount:        null,
            tx_hash:       prefix + this.config['COIN'] + '-' + family + '-' + digest,
            vout:          0,
            block_index:   ctx.blockIndex,
            block_time:    ctx.blockTime,
            raw_data:      null,
            fee:           null,
            source_pubkey: null,
            tx_outputs:    []
        };
    },

    /**
     * Read a token row WITHOUT interning a ticker id. getTokenInfo() calls createTicker(),
     * which assigns an index_tickers id to a tick that may never be created; that would move
     * the dense id order and therefore the replay, so the probe goes through getTickerId
     * (a plain SELECT) first and only reads the row when an id already exists.
     *
     * @param {string} tick
     * @returns {Promise<Object|null>} the getTokenInfo record, or null when no row exists
     */
    async tokenRow(tick){
        let id = await this.indexerDb.getTickerId(tick);
        if(this.util.isNull(id))
            return null;
        let info = await this.indexerDb.getTokenInfo(tick);
        return info ? info : null;
    },

    /**
     * SEAM. The shared token-row creation helper, factored OUT of
     * injectGasToken so one code path creates a token row from a parameter set, whether the
     * caller is the BTC genesis pass or a bridge settle leg on another chain.
     *
     * WHY A HELPER AT ALL. The XCHAIN row on DOGE and LTC must be byte-for-byte the row
     * injectGasToken writes on BTC, and a general bridged row must be created the same way.
     * Two independent creation paths would drift, and a drifted parameter is a different
     * token row on two chains, which is a different ledger hash.
     *
     * THE XCHAIN CALL SITE PASSES THE BYTE-IDENTICAL injectGasToken SET. That is the whole
     * contract of this refactor and it is a hard obligation, not a preference: genesis must
     * be byte-identical before and after on every chain, which the replay pin test asserts.
     * injectGasToken itself is NOT rewritten by this seam.
     *
     * ROUTED THROUGH processTransaction(tx, true), so the row is ACTION-DERIVED: its
     * index_tickers id is assigned at a consensus action index and it enters the hashes for
     * free. The `true` stamps data['IS_GENESIS'], which is also what exempts the injected
     * creation from the bridge-owned ISSUE refusal off BTC and from the reserved-tick guard.
     * A broadcast action never carries that flag, so no historical verdict moves.
     *
     * IDEMPOTENT. A row that already exists is a no-op, not an error: the first XBRIDGE
     * in-leg on a chain creates it and every later leg finds it.
     *
     * @param {Object} params - the token parameter set, one per ISSUE format 0 field:
     * @param {string} params.tick           - ticker name ('XCHAIN' for the gas token; the
     *                                         rooted <ORIGIN>.<NAME> form for a bridged row)
     * @param {string} params.owner          - owning address (ADDRESS.GAS for the gas token,
     *                                         ADDRESS.BRIDGE_<ORIGIN> for a bridged row,
     *                                         which is keyless by design)
     * @param {string} params.maxSupply      - MAX_SUPPLY ('100000000' for the gas token;
     *                                         omitted, stored 0, the uncapped sentinel, for
     *                                         a bridged row, because a copied cap would go
     *                                         stale on the origin's next MINT)
     * @param {string|number} params.decimals - DECIMALS (8 for the gas token; the signed
     *                                         `decimals` from the transfer record for a
     *                                         bridged child row; 0 for a bridge root row)
     * @param {string} params.lockMaxSupply  - LOCK_MAX_SUPPLY (empty for the gas token, and
     *                                         NOT set on a bridged row: locking with no
     *                                         positive cap is refused)
     * @param {string|number} params.mintStartBlock - MINT_START_BLOCK (999999999, the
     *                                         sentinel that disables mint until lowered)
     * @param {string} params.mintSupply     - MINT_SUPPLY (empty: no pre-mint)
     * @param {string} params.description    - DESCRIPTION
     * @param {Object} params.locks          - the remaining lock flags as an object keyed by
     *                                         wire field name (LOCK_MINT, LOCK_MINT_SUPPLY,
     *                                         LOCK_MAX_MINT, LOCK_DESCRIPTION, LOCK_SLEEP,
     *                                         LOCK_CALLBACK); empty for the gas token, all
     *                                         set on a bridged row
     * @param {Object} ctx - creation context: { blockIndex, blockTime, txHashPrefix }.
     *                       txHashPrefix distinguishes the synthetic transaction families
     *                       ('GENESIS-' for the genesis pass, 'XPOLICY-' for a policy leg),
     *                       so an injected row can never collide with another pass's hash.
     *                       Three optional fields extend it, all defaulting to the genesis
     *                       behaviour so the seam's three-field ctx keeps producing the
     *                       historical transaction: `txHashFamily` (default 'GAS') is the
     *                       readable hash segment AND the digest's domain separator,
     *                       `txHashSalt` distinguishes two injections for the same tick in
     *                       the same family, and `skipExistsProbe` skips the idempotency
     *                       read for a caller that already knows the row is absent
     * @returns {Promise<{created: boolean, tick: string}>} created false when the row was
     *          already present
     */
    async injectProtocolToken(params, ctx){
        ctx = ctx || {};
        let tick = String(params.tick);
        // Idempotent by design: the first in-leg on a chain creates the row and every later
        // leg finds it. An existing row is a no-op and NOT an error, so a settle pass never
        // has to know whether it is the first one. ctx.skipExistsProbe is for the one caller
        // that already knows the row cannot be there (see injectGasToken).
        if(!ctx.skipExistsProbe){
            let existing = await this.tokenRow(tick);
            if(existing)
                return { created: false, tick: tick };
        }
        let tx = this.syntheticIssueTx(this.issueFields(params), tick, params.owner, ctx);
        await this.actions.processTransaction(tx, true); // isGenesis = true (stamps IS_GENESIS)
        return { created: true, tick: tick };
    },

};
