# XChain Platform - Documentation

This directory contains information on the XChain Platform and the various `ACTIONS` that are supported on the platform.

## `ACTION` commands
Below is a list of the defined `ACTION` commands and the function of each:

| ACTION                                | Description                                                                                   | 
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`ADDRESS`](./actions/ADDRESS.md)     | This action configures address specific options.                                              |
| [`AIRDROP`](./actions/AIRDROP.md)     | This action airdrops `TICK` supply to one or more lists.                                      |
| [`BATCH`](./actions/BATCH.md)         | This action batch executes multiple `ACTION` commands in a single transaction.                |
| [`BROADCAST`](./actions/BROADCAST.md) | This action broadcasts a message, and can also be used to create oracles and betting feeds.   |
| [`CALLBACK`](./actions/CALLBACK.md)   | This action performs a callback on a `TICK`.                                                  |
| [`DESTROY`](./actions/DESTROY.md)     | This action destroys `TICK` supply.                                                           |
| [`DISPENSER`](./actions/DISPENSER.md) | This action creates a dispenser (vending machine) to dispense `TICK` when triggered.          |
| [`DIVIDEND`](./actions/DIVIDEND.md)   | This action pays a dividend to holders of `TICK`.                                             |
| [`FILE`](./actions/FILE.md)           | This action uploads a file including file metadata.                                           |
| [`ISSUE`](./actions/ISSUE.md)         | This action creates or updates a `TICK`.                                                      |
| [`LINK`](./actions/LINK.md)           | This action links actions using `ACTION_INDEX`, including linking actions across blockchains. |
| [`LIST`](./actions/LIST.md)           | This action creates a list of items for use in actions.                                       |
| [`MESSAGE`](./actions/MESSAGE.md)     | This action allows for the sending of plaintext and encrypted messages between addresses.     |
| [`MINT`](./actions/MINT.md)           | This action mints `TICK` supply.                                                              |
| [`ORDER`](./actions/ORDER.md)         | This action creates a order to sell an item on the Decentralized Exchange (DEX).              |
| [`SEND`](./actions/SEND.md)           | This action sends one or more `TICK` to an `ADDRESS`.                                         |
| [`SLEEP`](./actions/SLEEP.md)         | This action pauses actions on `TICK` until `RESUME_BLOCK` is reached.                         |
| [`SWEEP`](./actions/SWEEP.md)         | This action transfers all `TICK` balances and/or ownerships to an `DESTINATION` address.      |

# Copyright
This document is placed in the public domain.

