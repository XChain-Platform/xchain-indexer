# XChain Platform Action - BATCH
This action batch executes multiple `ACTION` commands in a single transaction

## PARAMS
| Name      | Type   | Description                       |
| --------- | ------ | --------------------------------- |
| `VERSION` | String | Format Version                    |
| `COMMAND` | String | Any valid `ACTION` with `PARAMS`  |

## Formats

### Version `0`
- `VERSION|COMMAND;COMMAND`

## Examples
```
BATCH|0|MINT|0|XCHAIN|100;ISSUE|0|JDOG
This example mints 100 XCHAIN tokens and issues the JDOG token
```

## Rules
- Can only use one `MINT` command in a `BATCH` command
- Can only use one `ISSUE` command in a `BATCH` command
- Can not use `BATCH` as a command in a `BATCH` command

## Notes
- `COMMANDS` are separated by a semi-colon `;`
