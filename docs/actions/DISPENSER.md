#  XChain Platform Action - DISPENSER
This action creates a dispenser (vending machine) to dispense `TICK` when triggered

## PARAMS
| Name             | Type   | Description                                                                |
| ---------------- | ------ | -------------------------------------------------------------------------- |
| `VERSION`        | String | Format Version                                                             |
| `GIVE_TICK`      | String | 1 to 250 characters in length                                              |
| `GIVE_AMOUNT`    | String | Quantity of `GIVE_TICK` to dispense when triggered                         |
| `ESCROW_AMOUNT`  | String | Quantity of `GIVE_TICK` to escrow in dispenser                             |
| `TRIGGER_TICK`   | String | `TICK` or native `COIN` to trigger the                                     |
| `TRIGGER_AMOUNT` | String | Quantity of `TRIGGER_TICK` required per dispense                           |
| `STATUS`         | String | The state of the dispenser. (1=Open, 10=Close)                             |
| `ADDRESS`        | String | Address for dispenser to operate on (default=`SOURCE`)                     |
| `FIAT_CODE`      | String | code for `FIAT` currency your dispenser is priced in (USD, JPY, GPB, etc.) |
| `ALLOW_LIST`     | String | `ACTION_INDEX` of a `LIST` of addresses allowed to trigger dispenser       |
| `BLOCK_LIST`     | String | `ACTION_INDEX` of a `LIST` of addresses NOT allowed to trigger a dispenser |

## Formats

### Version `0`
- `VERSION|GIVE_TICK|GIVE_AMOUNT|ESCROW_AMOUNT|TRIGGER_TICK|TRIGGER_AMOUNT|STATUS|ADDRESS|FIAT_CODE|ALLOW_LIST|BLOCK_LIST`

## Examples
```
DISPENSER|0|JDOG|1|1|BTC|1.00000000|0|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev
This example creates a dispenser and escrows 1 JDOG `token` in it, which will dispense when 1.00000000 BTC is sent to 1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev
```

```
DISPENSER|0|JDOG|1|1|BTC|1.00000000|10
This example closes the dispenser in example 1 and credits any escrowed JDOG to the dispenser address 1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev
```

```
DISPENSER|0|BRRR|1000|1|TEST|1|0|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev
This example creates a dispenser and escrows 1000 BRRR `token` in it, which will dispense when 1 TEST `token` is sent to 1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev
```

```
DISPENSER|0|BRRR|1000|1|TEST|1|0|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev
This example closes the dispenser in example 3 and credits any escrowed BRRR to the address 1BrrrrLLzVq8ZP1nE3BHKQZ14dBXkRVsx4
```


## Rules
- Dispensers can be closed by the `DISPENSER` address or `ORIGIN` address which first opened the dispenser
- `TRIGGER_TICK` defaults to native `COIN` (BTC, LTC, DOGE, etc)
- `TRIGGER_TICK` must be set to native `COIN` if `FIAT_CODE` is specified

## Notes
- Can create a dispenser on any valid address (no new/empty address limitation like CP)
- `STATUS` changes to `10` when a dispener is closed
- `STATUS` changes to `10` automatically when a dispenser runs out of `tokens` to dispense
- When specifying `FIAT_CODE`, `TRIGGER_AMOUNT` format becomes X.XX (fiat)
- `FIAT_CODE` accepts the following values:
  - `USD` = US Dollar
  - `CAD` = Canadian Dollar
  - `AUD` = Austrailian Dollar
  - `MXN` = Mexican Peso
  - `GBP` = Great Britian Pound
  - `JPY` = Japanese Yen
  - `CNY` = Chinese Yuan
  - `CHF` = Swiss Franc
  - `BRL` = Brazillian Real
  - `INR` = Indian Rupee
