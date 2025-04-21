# XChain Platform Action - SWEEP 
This action transfers all `TICK` balances and/or ownerships to an `DESTINATION` address.

## PARAMS
| Name          | Type   | Description              			                                 |
| ------------- | ------ | ----------------------------------------------------------------- |
| `VERSION`     | String | Format Version                                                    |
| `DESTINATION` | String | address where `token` shall be swept                              |
| `BALANCES` 	 | String | Indicates if address `TICK` balances should be swept (default=1)  |
| `OWNERSHIPS`  | String | Indicates if address `TICK` ownership should be swept (default=1) |
| `MEMO` 		 | String | Optional memo to include                                          |

## Formats

### Version `0`
- `VERSION|DESTINATION|BALANCES|OWNERSHIPS|MEMO`

## Examples
```
SWEEP|0|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1|1
This example sweeps both `TICK` balances and ownerships from the `SOURCE` address to 1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev
```

```
SWEEP|0|1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9|0|1
This example sweeps only `TICK` ownerships from the `SOURCE` address to 1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9
```

## Rules
- `MEMO` characters **NOT** allowed are :
   - pipe `|` (used as field separator)
   - semicolon `;` (used as command separator)

## Notes
