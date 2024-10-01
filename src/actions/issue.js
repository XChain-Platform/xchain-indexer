/*********************************************************************
 * XChain Indexer ACTION - ISSUE
 * 
 * PARAMS:
 * - VERSION          - Broadcast Format Version
 * - TICK             - 1 to 250 characters in length
 * - MAX_SUPPLY       - Maximum token supply 
 * - MAX_MINT         - Maximum amount of supply a `MINT` transaction can issue
 * - DECIMALS         - Number of decimal places token should have (max: 18, default: 0)
 * - DESCRIPTION      - Description of token (250 chars max) 
 * - MINT_SUPPLY      - Amount of token supply to mint in immediately (default:0)
 * - TRANSFER         - Address to transfer ownership of the `token` to (owner can perform future actions on token)
 * - TRANSFER_SUPPLY  - Address to transfer `MINT_SUPPLY` to (mint initial supply and transfer to address)
 * - LOCK_MAX_SUPPLY  - Lock `MAX_SUPPLY` permanently (cannot increase `MAX_SUPPLY`)
 * - LOCK_MINT        - Lock `token` against `MINT` command
 * - LOCK_MAX_MINT    - Lock `MAX_MINT` permanently (cannot edit `MAX_MINT`)
 * - LOCK_DESCRIPTION - Lock `token` against `DESCRIPTION` changes
 * - LOCK_RUG         - Lock `token` against `RUG` command
 * - LOCK_SLEEP       - Lock `token` against `SLEEP` command
 * - LOCK_CALLBACK    - Lock `token` `CALLBACK` info
 * - CALLBACK_BLOCK   - Enable `CALLBACK` command after `CALLBACK_BLOCK` 
 * - CALLBACK_TICK    - `TICK` `token` users get when `CALLBACK` command is used
 * - CALLBACK_AMOUNT  - `TICK` `token` amount that users get when `CALLBACK` command is used
 * - ALLOW_LIST       - `TX_HASH` of a BTNS LIST of addresses allowed to interact with this token
 * - BLOCK_LIST       - `TX_HASH` of a BTNS LIST of addresses NOT allowed to interact with this token
 * - MINT_ADDRESS_MAX - Maximum amount of supply any address can mint via `MINT` transactions
 * - MINT_START_BLOCK - `BLOCK_INDEX` when `MINT` transactions are allowed (begin mint)
 * - MINT_STOP_BLOCK` - `BLOCK_INDEX` when `MINT` transactions are NOT allowed (end mint)
 * 
 * FORMATS :
 * - 0 = Full
 * - 1 = Brief
 * - 2 = Edit MINT PARAMS
 * - 3 = Edit LOCK PARAMS
 * - 4 = Edit CALLBACK PARAMS
 * 
 ********************************************************************/

const util    = require('../util.js');

class Issue {

    // Handle constructing a class instance
    constructor(decoderDb, indexerDb){
        // Setup alias to the indexer database connections
        this.decoderDb = decoderDb;
        this.indexerDb = indexerDb;

    }

    // Handle parsing the ISSUE transaction
    async parse(params, data, error){
        console.log('parse params=',params);
        console.log('parse data=',data);
    }

}

module.exports = Issue;