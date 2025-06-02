#  XChain Platform Action - ORDER
This action creates a order to sell an item on the Decentralized Exchange (DEX).

## PARAMS
| Name                 | Type   | Description                                                        |
| -------------------- | ------ | ------------------------------------------------------------------ |
| `VERSION`            | String | Format Version                                                     |
| `GIVE_COIN`          | String | `COIN` name (BTC, LTC, DOGE, etc)                                  |
| `GIVE_TICK`          | String | Ticker name or Ticker ID                                           |
| `GIVE_AMOUNT`        | String | Quantity of `GIVE_TICK` to escrow in the orde                      |
| `GET_COIN`           | String | `COIN` name (BTC, LTC, DOGE, etc)                                  |
| `GET_TICK`           | String | Ticker name or Ticker ID                                           |
| `GET_AMOUNT`         | String | Quantity of `GET_TICK` requested in return                         |
| `GET_ADDRESS`        | String | Address to receive `GET_TICK` on `GET_COIN` network                |
| `EXPIRATION`         | String | Timestamp of when order should expire, in Unix time                |
| `ALLOW_LIST`         | String | `ACTION_INDEX` of a `LIST` of addresses allowed to match order     |
| `BLOCK_LIST`         | String | `ACTION_INDEX` of a `LIST` of addresses NOT allowed to match order |
| `MEMO`               | String | An optional memo to include                                        |
| `ORDER_ACTION_INDEX` | String | `ACTION_INDEX` of existing `ORDER`                                 |


## Formats

### Version `0` - Create Order
- `VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO`

### Version `1` - Cancel Order
- `VERSION|ORDER_ACTION_INDEX|MEMO`

### Version `2` - Edit Order 
- `VERSION|ORDER_ACTION_INDEX|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO`


## Examples
```
ORDER|0|BTC|RAREPEPE|1|BTC|PEPECASH|10000000.00000000||||Selling my RAREPEPE cuz mom in hospital
This example creates an order to sell 1 RAREPEPE for 10,000,000.00000000 PEPECASH and includes a memo
```

```
ORDER|1|1234|Closing order, no buyers, much disappoint
This example cancels the existing ORDER with `ACTION_INDEX` 1234 and includes a memo
```

```
ORDER|2|1234|4321|||Updating order to only sell to club member addresses
This example updates an existing `ORDER` with `ACTION_INDEX` 1234 and adds an `ACTION_INDEX` to `ALLOW_LIST` 4321 and includes a memo
```

## Rules

## Notes
- Use `^` (caret) as prefix when passing `TICK_ID` for `TICK` field (^1234 = `TICK_ID` 1234)