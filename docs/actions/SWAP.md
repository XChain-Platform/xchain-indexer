#  XChain Platform Action - SWAP
This action allows for swapping tokens across XChain platform supported blockchains.

## PARAMS
| Name                | Type   | Description                                        |
| ------------------- | ------ | -------------------------------------------------- |
| `VERSION`           | String | Format Version                                     |
| `GIVE_TICK`         | String | 1 to 250 characters in length                      |
| `GIVE_AMOUNT`       | String | Quantity of `GIVE_TICK` to escrow in the swap      |
| `GET_COIN`          | String | `COIN` name (BTC, LTC, DOGE, etc)                  |
| `GET_TICK`          | String | 1 to 250 characters in length                      |
| `GET_AMOUNT`        | String | Quantity of `GET_TICK` requested in return         |
| `EXPIRATION`        | String | Timestamp of when swap should expire, in Unix time |
| `MEMO`              | String | An optional memo to include                        |
| `SWAP_ACTION_INDEX` | String | `ACTION_INDEX` of existing `SWAP`                  |

## Formats

### Version `0` - Create Swap
- `VERSION|GIVE_TICK|GIVE_AMOUNT|GET_COIN|GET_TICK|GET_AMOUNT|EXPIRATION|MEMO`

### Version `1` - Cancel Swap
- `VERSION|SWAP_ACTION_INDEX|MEMO`

### Version `2` - Edit Swap
- `VERSION|SWAP_ACTION_INDEX|EXPIRATION|MEMO`

## Examples
```
SWAP|0|RAREPEPE|1|BTC|PEPECASH|10000000.00000000||Swapping my RAREPEPE for 10M PEPECASH
This example creates a swap 1 RAREPEPE for 10,000,000.00000000 PEPECASH and includes a memo
```

```
SWAP|1|1234|Cancelling swap, no takers, much disappoint
This example cancels an existing SWAP with `ACTION_INDEX` 1234 and includes a memo
```

```
SWAP|2|1234|1767254400|Extending SWAP until Jan 1 2026
This example updates an existing SWAP with `ACTION_INDEX` 1234, extends the `EXPIRATION` time, and includes a memo
```

## Rules
- `GET_COIN` value must be a valid coin network (BTC, LTC, DOGE, etc)
- `SWAP_ACTION_INDEX` must point to a valid `ACTION_INDEX` on the current `COIN` network

## Notes
- `SWAP` DOES NOT work with native `COIN` (BTC, LTC, DOGE)
- Use a `DISPENSER` if you want to sell a `TICK` for `COIN` (BTC, LTC, DOGE)
