#  XChain Platform Action - BROADCAST
This action broadcasts a message, and can also be used to create oracles and betting feeds.

## PARAMS
| Name                     | Type   | Description                                                |
| ------------------------ | ------ | ---------------------------------------------------------- |
| `VERSION`                | String | Format Version                                             |
| `MESSAGE`                | String | A text string                                              |
| `VALUE`                  | String | Numerical value                                            |
| `FEE`                    | String | Indicates usage percentage fee (1=1%, 2=2%, etc)           |
| `MEMO`                   | String | An optional memo to include                                |
| `BROADCAST_ACTION_INDEX` | String | `ACTION_INDEX` of broadcast action                         |

## Formats

### Version `0` - Broadcast Message
- `VERSION|MESSAGE|VALUE`

### Version `1` - Broadcast Oracle
- `VERSION|MESSAGE|VALUE|FEE|MEMO`

### Version `2` - Broadcast Feed
- `VERSION|MESSAGE|FEE|MEMO`

### Version `3` - Broadcast Feed Results
- `VERSION|BROADCAST_ACTION_INDEX|VALUE|MEMO`

## Examples
```
BROADCAST|0|This is a test
This example broadcasts a simple message
```

```
BROADCAST|1|BTC-USD|84860|0.01|BTC Price on Sat Apr 12 2025 14:35:36 UTC
This example creates an oracle for BTC-USD price, gives the current price, indicates a 1% oracle usage fee, and includes a memo
```

```
BROADCAST|2|https://oracle-betting-site.com/superbowl-2025.json|1|Bet on the 2025 Superbowl!
This example creates feed for betting on the superbowl results, charges a 1% oracle usage fee, and includes a memo
```

```
BROADCAST|3|1234|2|Superbowl Results on Tue Aug 19 2025 01:55:00 UTC
This example broadcasts the results of the superbowl feed in the previous example with an `ACTION_INDEX` of 1234, and includes a memo
```


## Rules

## Notes
- `CAST` `ACTION` can be used for shorter reference to `BROADCAST` `ACTION`
- Price oracles can be created by broadcasting TICK-FIAT as `MESSAGE`, price as `VALUE`, and a `FEED_FEE` and `TIMESTAMP`
- Betting feed can be created by broadcasting the feed JSON file url as `MESSAGE`, a `FEED_FEE` and `TIMESTAMP` using `FORMAT` 2
- Betting feed can be resolved by broadcasting the feed `BROADCAST_ACTION_INDEX`, the winning value as `VALUE`, and `TIMESTAMP` using `FORMAT` 3
