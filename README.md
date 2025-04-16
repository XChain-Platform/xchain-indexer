# XChain Platform Indexer

This directory contains the basic XChain platform indexer written in javascript which supports indexing XChain platform transactions, determining status of transactions, and populating a database with the indexed data.

This indexer was born from the Broadcast Token Naming System (BTNS) project found at https://github.com/jdogresorg/Broadcast-Token-Naming-System

## `ACTION` commands
Below is a list of the defined `ACTION` commands and the function of each:

| ACTION                                    | Description                                                                                   | 
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`ADDRESS`](./src/actions/ADDRESS.md)     | This action configures address specific options.                                              |
| [`AIRDROP`](./src/actions/AIRDROP.md)     | This action airdrops `TICK` supply to one or more lists.                                      |
| [`BATCH`](./src/actions/BATCH.md)         | This action batch executes multiple `ACTION` commands in a single transaction.                |
| [`BROADCAST`](./src/actions/BROADCAST.md) | This action broadcasts a message, and can also be used to create oracles and betting feeds.   |
| [`CALLBACK`](./src/actions/CALLBACK.md)   | This action performs a callback on a `TICK`.                                                  |
| [`DESTROY`](./src/actions/DESTROY.md)     | This action destroys `TICK` supply.                                                           |
| [`DISPENSER`](./src/actions/DISPENSER.md) | This action creates a dispenser (vending machine) to dispense `TICK` when triggered.          |
| [`DIVIDEND`](./src/actions/DIVIDEND.md)   | This action pays a dividend to holders of `TICK`.                                             |
| [`FILE`](./src/actions/FILE.md)           | This action uploads a file including file metadata.                                           |
| [`ISSUE`](./src/actions/ISSUE.md)         | This action creates or updates a `TICK`.                                                      |
| [`LINK`](./src/actions/LINK.md)           | This action links actions using `ACTION_INDEX`, including linking actions across blockchains. |
| [`LIST`](./src/actions/LIST.md)           | This action creates a list of items for use in actions.                                       |
| [`MESSAGE`](./src/actions/MESSAGE.md)     | This action allows for the sending of plaintext and encrypted messages between addresses.     |
| [`MINT`](./src/actions/MINT.md)           | This action mints `TICK` supply.                                                              |
| [`ORDER`](./src/actions/ORDER.md)         | This action creates a order to sell an item on the Decentralized Exchange (DEX).              |
| [`SEND`](./src/actions/SEND.md)           | This action sends one or more `TICK` to an `ADDRESS`.                                         |
| [`SLEEP`](./src/actions/SLEEP.md)         | This action pauses actions on `TICK` until `RESUME_BLOCK` is reached.                         |
| [`SWAP`](./src/actions/SWAP.md)           | This action allows for swapping tokens across XChain platform supported blockchains.          |
| [`SWEEP`](./src/actions/SWEEP.md)         | This action transfers all `TICK` balances and/or ownerships to an `DESTINATION` address.      |
