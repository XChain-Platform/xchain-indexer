# XChain Platform Action - DESTROY
This action destroys `TICK` supply.

## PARAMS
| Name      | Type   | Description                 |
| --------- | ------ | --------------------------- |
| `VERSION` | String | Format Version              |
| `TICK`    | String | Ticker name or Ticker ID    |
| `AMOUNT`  | String | Amount of `TICK` to destroy |
| `MEMO`    | String | An optional memo to include |

## Formats

### Version `0`
- `VERSION|TICK|AMOUNT|MEMO`

### Version `1`
- `VERSION|TICK|AMOUNT|TICK|AMOUNT|MEMO`

### Version `2`
- `VERSION|TICK|AMOUNT|MEMO|TICK|AMOUNT|MEMO`


## Examples
```
DESTROY|0|BRRR|1
This example destroys 1 BRRR token from the broadcasting address
```

```
DESTROY|1|BRRR|1|GAS|10
This example destroys 1 BRRR token and 10 GAS tokens from the broadcasting address
```

```
DESTROY|2|BRRR|1|foo|GAS|10|bar
This example destroys 1 BRRR token with the memo `foo`, and 10 GAS tokens with the memo `bar` from the broadcasting address
```

## Rules
- Any destroyed `TICK` supply will be debited from broadcasting address balances

## Notes
- Format version `0` allows for a single destroy
- Format version `1` allows for repeating `TICK` and `AMOUNT` params to enable multiple destroys
- Format version `2` allows for repeating `TICK`, `AMOUNT`, and `MEMO` params to enable multiple destroys
- Format version `0` and `1` allow for a single optional `MEMO` field to be included as the last PARAM
- Use `^` (caret) as prefix when passing `TICK_ID` for `TICK` field (^1234 = `TICK_ID` 1234)