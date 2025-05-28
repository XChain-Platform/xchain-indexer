#  XChain Platform Action - SWAP
This action allows for swapping tokens across XChain platform supported blockchains.

## PARAMS
| Name                | Type   | Description                                                       |
| ------------------- | ------ | ----------------------------------------------------------------- |
| `VERSION`           | String | Format Version                                                    |
| `GIVE_COIN`         | String | `COIN` name (BTC, LTC, DOGE, etc)                                 |
| `GIVE_TICK`         | String | Ticker name or Ticker ID                                          |
| `GIVE_AMOUNT`       | String | Quantity of `GIVE_TICK` to escrow in the swap                     |
| `GET_COIN`          | String | `COIN` name (BTC, LTC, DOGE, etc)                                 |
| `GET_TICK`          | String | Ticker name or Ticker ID                                          |
| `GET_AMOUNT`        | String | Quantity of `GET_TICK` requested in return                        |
| `GET_ADDRESS`       | String | Address to receive `GET_TICK` on `GET_COIN` network               |
| `EXPIRATION`        | String | Timestamp of when swap should expire, in Unix time                |
| `ALLOW_LIST`        | String | `ACTION_INDEX` of a `LIST` of addresses allowed to match swap     |
| `BLOCK_LIST`        | String | `ACTION_INDEX` of a `LIST` of addresses NOT allowed to match swap |
| `MEMO`              | String | An optional memo to include                                       |
| `SWAP_ACTION_INDEX` | String | `ACTION_INDEX` of existing `SWAP`                                 |

## Formats

### Version `0` - Create Swap
- `VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO`

### Version `1` - Cancel Swap
- `VERSION|SWAP_ACTION_INDEX|MEMO`

### Version `2` - Edit Swap
- `VERSION|SWAP_ACTION_INDEX|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO`

## Examples
```
SWAP|0|BTC|RAREPEPE|1|BTC|PEPECASH|10000000.00000000|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev||||Swapping my RAREPEPE for 10M PEPECASH
This example creates a swap 1 RAREPEPE for 10,000,000.00000000 PEPECASH and includes a memo
```

```
SWAP|1|1234|Cancelling swap, no takers, much disappoint
This example cancels an existing SWAP with `ACTION_INDEX` 1234 and includes a memo
```

```
SWAP|2|1234|1767254400|||Extending SWAP until Jan 1 2026
This example updates an existing SWAP with `ACTION_INDEX` 1234, extends the `EXPIRATION` time, and includes a memo
```

## Rules
- `GET_COIN` value must be a valid coin network (BTC, LTC, DOGE, etc)
- `GET_ADDRESS` value must be a valid address on the given `GET_COIN` coin network (BTC, LTC, DOGE, etc.)
- `SWAP_ACTION_INDEX` must point to a valid `ACTION_INDEX` on the current `COIN` network

## Notes
- `SWAP` DOES NOT work with native `COIN` (BTC, LTC, DOGE)
- Use a `DISPENSER` if you want to sell a `TICK` for `COIN` (BTC, LTC, DOGE)
- Use `^` (caret) as prefix when passing `TICK_ID` for `TICK` field (^1234 = `TICK_ID` 1234)
- `GET_ADDRESS` can be null if the `GET_COIN` network is the same as the `SWAP` transaction network (`SOURCE` is used by default)