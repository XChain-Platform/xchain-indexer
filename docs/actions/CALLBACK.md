# XChain Platform Action - CALLBACK
This action performs a callback on a `TICK`. 

## PARAMS
| Name      | Type   | Description                 |
| --------- | ------ | --------------------------- |
| `VERSION` | String | Format Version              |
| `TICK`    | String | Ticker name or Ticker ID    |
| `MEMO`    | String | An optional memo to include |

## Formats

### Version `0`
- `VERSION|TICK|MEMO`

## Examples
```
CALLBACK|0|JDOG
This example calls back the JDOG token to the token owner address
```

## Rules
- `TICK` can only be called back after `CALLBACK_BLOCK`
- All `TICK` supply will be returned to `TICK` owner address
- All `TICK` supply holders will receive `CALLBACK_AMOUNT` of `CALLBACK_TICK` per `UNIT`

## Notes
- `CALLBACK` requires an `XCHAIN` fee based on number of database hits
- `UNIT` - A specific unit of measure (1 or 1.0)
- `CALLBACKS` respect `CALLBACK_TICK` `ALLOW_LIST` and `BLOCK_LIST` and will only distribute `CALLBACK_TICK` to authorized holders
- Use `^` (caret) as prefix when passing `TICK_ID` for `TICK` field (^1234 = `TICK_ID` 1234)