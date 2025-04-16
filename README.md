# XChain Platform Indexer

This directory contains the basic XChain platform indexer written in javascript which supports indexing XChain platform transactions, determining status of transactions, and populating a database with the indexed data.

This indexer was born from the Broadcast Token Naming System (BTNS) project found at https://github.com/jdogresorg/Broadcast-Token-Naming-System

## `ACTION` commands
Below is a list of the defined `ACTION` commands and the function of each:

| ACTION                                     | Description                                                                                   | 
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| [`ADDRESS`](./docs/actions/ADDRESS.md)     | This action configures address specific options.                                              |
| [`AIRDROP`](./docs/actions/AIRDROP.md)     | This action airdrops `TICK` supply to one or more lists.                                      |
| [`BATCH`](./docs/actions/BATCH.md)         | This action batch executes multiple `ACTION` commands in a single transaction.                |
| [`BROADCAST`](./docs/actions/BROADCAST.md) | This action broadcasts a message, and can also be used to create oracles and betting feeds.   |
| [`CALLBACK`](./docs/actions/CALLBACK.md)   | This action performs a callback on a `TICK`.                                                  |
| [`DESTROY`](./docs/actions/DESTROY.md)     | This action destroys `TICK` supply.                                                           |
| [`DISPENSER`](./docs/actions/DISPENSER.md) | This action creates a dispenser (vending machine) to dispense `TICK` when triggered.          |
| [`DIVIDEND`](./docs/actions/DIVIDEND.md)   | This action pays a dividend to holders of `TICK`.                                             |
| [`FILE`](./docs/actions/FILE.md)           | This action uploads a file including file metadata.                                           |
| [`ISSUE`](./docs/actions/ISSUE.md)         | This action creates or updates a `TICK`.                                                      |
| [`LINK`](./docs/actions/LINK.md)           | This action links actions using `ACTION_INDEX`, including linking actions across blockchains. |
| [`LIST`](./docs/actions/LIST.md)           | This action creates a list of items for use in actions.                                       |
| [`MESSAGE`](./docs/actions/MESSAGE.md)     | This action allows for the sending of plaintext and encrypted messages between addresses.     |
| [`MINT`](./docs/actions/MINT.md)           | This action mints `TICK` supply.                                                              |
| [`ORDER`](./docs/actions/ORDER.md)         | This action creates a order to sell an item on the Decentralized Exchange (DEX).              |
| [`SEND`](./docs/actions/SEND.md)           | This action sends one or more `TICK` to an `ADDRESS`.                                         |
| [`SLEEP`](./docs/actions/SLEEP.md)         | This action pauses actions on `TICK` until `RESUME_BLOCK` is reached.                         |
| [`SWAP`](./docs/actions/SWAP.md)           | This action allows for swapping tokens across XChain platform supported blockchains.          |
| [`SWEEP`](./docs/actions/SWEEP.md)         | This action transfers all `TICK` balances and/or ownerships to an `DESTINATION` address.      |
