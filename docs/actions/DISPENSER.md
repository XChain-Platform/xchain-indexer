#  XChain Platform Action - DISPENSER
This action creates a dispenser (vending machine) to dispense `TICK` when triggered

## PARAMS
| Name                     | Type   | Description                                                                |
| ------------------------ | ------ | -------------------------------------------------------------------------- |
| `VERSION`                | String | Format Version                                                             |
| `GIVE_TICK`              | String | Ticker name or Ticker ID                                                   |
| `GIVE_AMOUNT`            | String | Quantity of `GIVE_TICK` to dispense when triggered                         |
| `ESCROW_AMOUNT`          | String | Quantity of `GIVE_TICK` to escrow in dispenser                             |
| `TRIGGER_TICK`           | String | `TICK` or native `COIN` to trigger a dispense                              |
| `TRIGGER_AMOUNT`         | String | Quantity of `TRIGGER_TICK` required per dispense                           |
| `EXPIRATION`             | String | Timestamp of when dispenser should close, in Unix time                     |
| `ADDRESS`                | String | Address for dispenser to operate on (default=`SOURCE`)                     |
| `FIAT_CODE`              | String | Code for `FIAT` currency your dispenser is priced in (USD, JPY, GPB, etc.) |
| `ALLOW_LIST`             | String | `ACTION_INDEX` of a `LIST` of addresses allowed to trigger dispenser       |
| `BLOCK_LIST`             | String | `ACTION_INDEX` of a `LIST` of addresses NOT allowed to trigger a dispenser |
| `DISPENSER_ACTION_INDEX` | String | `ACTION_INDEX` of existing `DISPENSER`                                     |

## Formats

### Version `0` - Create Dispenser
- `VERSION|GIVE_TICK|GIVE_AMOUNT|ESCROW_AMOUNT|TRIGGER_TICK|TRIGGER_AMOUNT|EXPIRATION|ADDRESS|FIAT_CODE|ALLOW_LIST|BLOCK_LIST`

### Version `1` - Close Dispenser
- `VERSION|DISPENSER_ACTION_INDEX|MEMO`

### Version `2` - Refill Dispenser
- `VERSION|DISPENSER_ACTION_INDEX|ESCROW_AMOUNT|EXPIRATION|MEMO`

### Version `3` - Edit Dispenser
- `VERSION|DISPENSER_ACTION_INDEX|ALLOW_LIST|BLOCK_LIST|EXPIRATION|MEMO`


## Examples
```
DISPENSER|0|JDOG|1|1|BTC|1.00000000|0||1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev
This example creates a dispenser and escrows 1 JDOG `token` in it, which will dispense when 1.00000000 BTC is sent to 1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev
```

```
DISPENSER|1|1234|Closing JDOG Dispenser
This example closes the dispenser in example 1 with `ACTION_INDEX` 1234
```

```
DISPENSER|2|1234|100||Refilling with 100
This example refills a dispenser with `ACTION_INDEX` 1234 with 100 JDOG tokens
```

```
DISPENSER|3|1234|9876|5432||Updating allow/block lists
This example updates the allow and block lists for dispenser with `ACTION_INDEX` 1234
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
- `EXPIRATION` begins the process of closing a dispenser after a set block delay
- Use `^` (caret) as prefix when passing `TICK_ID` for `TICK` field (^1234 = `TICK_ID` 1234)s