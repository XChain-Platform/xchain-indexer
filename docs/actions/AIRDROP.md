# XChain Platform Action - AIRDROP
This action airdrops `TICK` supply to one or more lists.

## PARAMS
| Name                | Type   | Description                 |
| ------------------- | ------ | --------------------------- |
| `VERSION`           | String | Format Version              |
| `TICK`              | String | Ticker name or Ticker ID    |
| `AMOUNT`            | String | Amount of `TICK` to airdrop |
| `LIST_ACTION_INDEX` | String | `ACTION_INDEX` of a `LIST`  |
| `MEMO`              | String | An optional memo to include |

## Formats

### Version `0` - Single Airdrop
- `VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO`

### Version `1` - Multi-Airdrop (Brief)
- `VERSION|LIST_ACTION_INDEX|TICK|AMOUNT|TICK|AMOUNT|MEMO`

### Version `2` - Multi-Airdrop (Full)
- `VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO`

### Version `3` - Multi-Airdrop (Full) with Multiple Memos
- `VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO`

## Examples
```
AIRDROP|0|GAS|1|1234
This example airdops 1 GAS to every holder on a list with ACTION_INDEX 1234
```

```
AIRDROP|1|GAS|1|1234|BRRR|2|4321
This example airdops 1 GAS to every holder on a list with ACTION_INDEX 1234 and 2 BRRR to every holder on a list with ACTION_INDEX 4321
```

## Rules

## Notes
- `AIRDROP` requires an `XCHAIN` fee based on number of database hits
- `DROP` `ACTION` can be used for shorter reference to `AIRDROP` `ACTION`
- `AIRDROP` to `ADDRESS` `LIST` sends `AMOUNT` of `TICK` to each address on the list
- `AIRDROP` to `TICK` `LIST` sends `AMOUNT` of `TICK` to holders of each `TICK` on the list
- Format version `0` allows for a single airdrop
- Format version `1` allows for repeating `TICK` and `AMOUNT` params to enable multiple airdrops to a single list
- Format version `2` allows for repeating `TICK`, `AMOUNT` and `LIST` params to enable multiple airdrops to multiple lists
- Format version `3` allows for repeating `TICK`, `AMOUNT`, `LIST`, and `MEMO` params to enable multiple airdrops to multiple lists with multiple memos
- Format version `0`, `1`, and `2` allow for a single optional `MEMO` field to be included as the last PARAM
- Use `^` (caret) as prefix when passing `TICK_ID` for `TICK` field (^1234 = `TICK_ID` 1234)