#  XChain Platform Action - LINK
This action links actions using `ACTION_INDEX`, including linking actions across blockchains.

## PARAMS
| Name                | Type   | Description                                |
| ------------------- | ------ | ------------------------------------------ |
| `VERSION`           | String | Format Version                             |
| `ACTION_INDEX`      | String | `ACTION_INDEX` of action                   |
| `COIN`              | String | `COIN` name (BTC, LTC, DOGE, etc)          |
| `COIN_ACTION_INDEX` | String | `ACTION_INDEX` of action on `COIN` network |
| `MEMO`              | String | An optional memo to include                |

## Formats

### Version `0`
- `VERSION|ACTION_INDEX|COIN|COIN_ACTION_INDEX|MEMO`

## Examples
```
LINK|0|4321|BTC|1234|Linking FILE upload to TICK
This example links a `FILE` upload with `ACTION_INDEX` 4321 with a `TICK` associated with `ACTION_INDEX` 1234
```

```
LINK|0|6666|DOGE|1234|Linking TICK with FILE upload on 
This example links a `FILE` upload on the DOGE network with `ACTION_INDEX` 6666 with a `TICK` associated with `ACTION_INDEX` 1234
```

## Rules
- `COIN` value must be a valid coin network (BTC, LTC, DOGE, etc)
- `COIN_ACTION_INDEX` must point to a valid `ACTION_INDEX` on the given `COIN` network

## Notes

