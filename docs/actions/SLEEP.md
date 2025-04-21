# XChain Platform Action - SLEEP
This action pauses actions on an `ADDRESS` or a `TICK` until `RESUME_BLOCK` is reached.

## PARAMS
| Name           | Type   | Description                   |
| -------------  | ------ | ----------------------------- |
| `VERSION`      | String | Format Version                |
| `TICK`         | String | Ticker name or Ticker ID      |
| `RESUME_BLOCK` | String | Block index to resume actions |
| `MEMO`         | String | An optional memo to include   |

## Formats

### Version `0` - Sleep `ADDRESS`
- `VERSION|RESUME_BLOCK|MEMO`

### Version `1` - Sleep `TICK`
- `VERSION|RESUME_BLOCK|TICK|MEMO`

## Examples

```
SLEEP|0|791495|Pausing actions until block 791495
This example sleeps / pauses all actions on the `SOURCE` address until block 791495
```

```
SLEEP|1|791495|JDOG|Pausing actions on JDOG until block 791495
This example sleeps / pauses all actions on JDOG `TICK` until block 791495
```

```
BATCH|0|
SLEEP|1|0|JDOG|Unsleeping actions on JDOG token;
ISSUE|1|JDOG|We are working to resolve the problem;
ISSUE|2|JDOG||1000;
SEND|0|JDOG|1000|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|Funding contract address;
MINT|0|JDOG||1000|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev;
SLEEP|1|-1|JDOG|Sleeping JDOG token again

This example uses BATCH action to resume actions, perform some actions on JDOG token, then sleep actions again
```

## Rules
- `SLEEP` on an address sleeps all address actions until `RESUME_BLOCK`

## Notes
- `SLEEP` does _NOT_ prevent `DISPENSER` dispenses, as that could result in a loss of user funds.
- `SLEEP` does _NOT_ prevent `ORDER` matches, as that could result in unmatched orders.
- `SLEEP` does _NOT_ prevent `SWAP` matches, as that could result in unmatched swaps.
- `SLEEP` does _NOT_ prevent usage of the `SLEEP` action when used on a `TICK`
- `SLEEP` does prevent usage of the `SLEEP` action and all other actions when used on an address until `RESUME_BLOCK` has passed
- `SLEEP` on a `TICK` with `RESUME_BLOCK` set to `0` value, will unpause `TICK` actions immediately.
- `SLEEP` on a `TICK` with `RESUME_BLOCK` set to `-1` value, will pause `TICK` actions indefinitely.
- `ISSUE` `TICK` with `LOCK_SLEEP` set to `1` to permanently prevent use of the `SLEEP` command
- Can use `BATCH` commands to stop `SLEEP`, execute `ACTION` commands, and then resume `SLEEP`, when used on a `TICK`
- Use `^` (caret) as prefix when passing `TICK_ID` for `TICK` field (^1234 = `TICK_ID` 1234)