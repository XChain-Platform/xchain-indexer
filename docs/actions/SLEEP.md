# XChain Platform Action - SLEEP
This action pauses actions on `TICK` until `RESUME_BLOCK` is reached.

## PARAMS
| Name           | Type   | Description                   |
| -------------  | ------ | ----------------------------- |
| `VERSION`      | String | Format Version                |
| `TICK`         | String | 1 to 250 characters in length |
| `RESUME_BLOCK` | String | Block index to resume actions |
| `MEMO`         | String | An optional memo to include   |

## Formats

### Version `0`
- `VERSION|TICK|RESUME_BLOCK|MEMO`

## Examples
```
SLEEP|0|JDOG|791495`
This example sleeps / pauses all actions on JDOG `TICK` until block 791495
```

```
BATCH|0|
SLEEP|0|JDOG|0;
ISSUE|1|JDOG|We are working to resolve the problem;
ISSUE|2|JDOG||1000;
SEND|0|JDOG|1000|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|Funding contract address;
MINT|0|JDOG||1000|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev;
SLEEP|0|JDOG|-1 

This example uses BATCH action to resume actions, perform some actions on JDOG token, then sleep actions again
```

## Rules

## Notes
- `SLEEP` does _NOT_ prevent `DISPENSER` dispenses, as that could result in a loss of user funds.
- `SLEEP` does _NOT_ prevent `ORDER` matches, as that could result in unmatched orders.
- `SLEEP` does _NOT_ prevent usage of the `SLEEP` command 
- `SLEEP` with `RESUME_BLOCK` set to `0` value, will unpause actions immediately.
- `SLEEP` with `RESUME_BLOCK` set to `-1` value, will pause actions indefinitely.
- `ISSUE` `TICK` with `LOCK_SLEEP` set to `1` to permanently prevent use of the `SLEEP` command
- Can use `BATCH` commands to stop `SLEEP`, execute `ACTION` commands, and then resume `SLEEP`, etc.