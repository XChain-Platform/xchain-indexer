#  XChain Platform Action - ORDER
This action creates a order to sell an item on the Decentralized Exchange (DEX)

## PARAMS
| Name                 | Type   | Description                                                        |
| -------------------- | ------ | ------------------------------------------------------------------ |
| `VERSION`            | String | Format Version                                                     |
| `GIVE_TICK`          | String | 1 to 250 characters in length                                      |
| `GIVE_AMOUNT`        | String | Quantity of `GIVE_TICK` to escrow in the orde                      |
| `GET_TICK`           | String | 1 to 250 characters in length                                      |
| `GET_AMOUNT`         | String | Quantity of `GET_TICK` requested in return                         |
| `EXPIRATION`         | String | The number of blocks for which the order should be valid           |
| `ALLOW_LIST`         | String | `ACTION_INDEX` of a `LIST` of addresses allowed to match order     |
| `BLOCK_LIST`         | String | `ACTION_INDEX` of a `LIST` of addresses NOT allowed to match order |
| `MEMO`               | String | An optional memo to include                                        |
| `ORDER_ACTION_INDEX` | String | `ACTION_INDEX` of existing `ORDER`                                 |


## Formats

### Version `0` - Create Order
- `VERSION|GIVE_TICK|GIVE_AMOUNT|GET_TICK|GET_AMOUNT|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO`

### Version `1` - Cancel Order
- `VERSION|ORDER_ACTION_INDEX|MEMO`

### Version `2` - Edit Order `LIST` `PARAMS`
- `VERSION|ORDER_ACTION_INDEX|ALLOW_LIST|BLOCK_LIST|MEMO`


## Examples
```
ORDER|0|RAREPEPE|1|PEPECASH|10,000,000.00000000||||Selling my RAREPEPE cuz mom in hospital
This example creates an order to sell 1 RAREPEPE for 10,000,000.00000000 PEPECASH and includes a memo
```

```
ORDER|1|1234|Closing order, no buyers, much disappoint
This example cancels the existing ORDER with `ACTION_INDEX` 1234 and includes a memo
```

```
ORDER|2|1234|4321||Updating order to only sell to club member addresses
This example updates an existing `ORDER` with `ACTION_INDEX` 1234 and adds an `ACTION_INDEX` to `ALLOW_LIST` 4321 and includes a memo
```

## Rules

## Notes