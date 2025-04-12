#  XChain Platform Action - BROADCAST
This action broadcasts a message, and can also be used to create oracles and betting feeds.

## PARAMS
| Name        | Type   | Description                                                       |
| ----------- | ------ | ----------------------------------------------------------------- |
| `VERSION`   | String | Format Version                                                    |
| `MESSAGE`   | String | A text string                                                     |
| `VALUE`     | String | Numerical value                                                   |
| `FEED_FEE`  | String | Indicates oracle usage percentage fee (fraction of 1, 0.05 = 5%)  |
| `TIMESTAMP` | String | The timestamp of the broadcast, in Unix time                      |

## Formats

### Version `0`
- `VERSION|MESSAGE|VALUE|FEED_FEE|TIMESTAMP`

## Examples
```
BROADCAST|0|This is a test
This example broadcasts a simple message
```

```
BROADCAST|0|BTC-USD|84860|0.01|1744468536
This example creates an oracle for BTC-USD price, gives the current price, indicates a 1% oracle usage fee, and sets the timestamp to 04/12/2025 @ 2:35pm UTC
```

```
BROADCAST|0|https://oracle-betting-site.com/superbowl-2025.json|-1|0.01|1744468536
This example creates an oracle for betting on the superbowl results, indicates this is a new feed (-1), charges a 1% oracle usage fee, and sets the timestamp to 04/12/2025 @ 2:35pm UTC
```

```
BROADCAST|0|https://oracle-betting-site.com/superbowl-2025.json|2|0.01|1755568500
This example broadcasts the results of the superbowl oracle in the previous example, charges a 1% oracle usage fee, and sets the timestamp to 08/19/2025 @ 9:55am UTC
```


## Rules
- `TIMESTAMP` must always be greater than the last broadcast `TIMESTAMP`

## Notes
- `CAST` `ACTION` can be used for shorter reference to `BROADCAST` `ACTION`
- Price oracles can be created by broadcasting TICK-FIAT as `MESSAGE`, price as `VALUE`, and a `FEED_FEE` and `TIMESTAMP`
- Betting feed can be created by broadcasting a feed JSON file url as `MESSAGE`, `-1` as `VALUE` to indicate a new feed, and a `FEED_FEE` and `TIMESTAMP`
- Betting feed can be resolved by broadcasting the feed JSON file url as `MESSAGE`, the winning value as `VALUE`, and `FEED_FEE` and `TIMESTAMP`
