# XChain Database Naming Structure

The XChain Platform follows the following database naming structure :

XChain_`{CHAIN}`\_`{NETWORK}`\_`{COMPONENT}`

# Chains

| Chain    | Name   |
---------- | ------ |
| Bitcoin  | `BTC`  |
| Dogecoin | `DOGE` |
| Litecoin | `LTC`  |

# Networks

| Network | Name      |
--------- | --------- |
| Mainnet | `Mainnet` |
| Testnet | `Testnet` |
| Regtest | `Regtest` |

# Components

| Component       | Name           |
----------------- | -------------- |
| Encoder/Decoder | `Transactions` |
| Address Indexer | `Addresses`    |
| Indexer         | `Data`         |

# Examples

## Bitcoin Table Names
- XChain_BTC_Mainnet_Transactions
- XChain_BTC_Testnet_Transactions
- XChain_BTC_Regtest_Transactions
- XChain_BTC_Mainnet_Addresses
- XChain_BTC_Testnet_Addresses
- XChain_BTC_Regtest_Addresses
- XChain_BTC_Mainnet_Data
- XChain_BTC_Testnet_Data
- XChain_BTC_Regtest_Data

## Litecoin Table Names
- XChain_LTC_Mainnet_Transactions
- XChain_LTC_Testnet_Transactions
- XChain_LTC_Regtest_Transactions
- XChain_LTC_Mainnet_Addresses
- XChain_LTC_Testnet_Addresses
- XChain_LTC_Regtest_Addresses
- XChain_LTC_Mainnet_Data
- XChain_LTC_Testnet_Data
- XChain_LTC_Regtest_Data

## Dogecoin Table Names
- XChain_DOGE_Mainnet_Transactions
- XChain_DOGE_Testnet_Transactions
- XChain_DOGE_Regtest_Transactions
- XChain_DOGE_Mainnet_Addresses
- XChain_DOGE_Testnet_Addresses
- XChain_DOGE_Regtest_Addresses
- XChain_DOGE_Mainnet_Data
- XChain_DOGE_Testnet_Data
- XChain_DOGE_Regtest_Data