# XChain Platform Action - ADDRESS
This action configures address specific options.

## PARAMS
| Name             | Type   | Description                             |
| ---------------- | ------ | ----------------------------------------|
| `VERSION`        | String | Format Version                          |
| `FEE_PREFERENCE` | String | Set preference for how `FEE` is used    |
| `REQUIRE_MEMO`   | String | Require a `MEMO` on any received `SEND` |
| `MEMO`           | String | An optional memo to include             |

## Formats

### Version `0`
- `VERSION|FEE_PREFERENCE|REQUIRE_MEMO|MEMO`

## Examples
```
ADDRESS|0|1|0
This example sets the address to DESTROY fees
```

```
ADDRESS|0|2|0
This example sets the address to DONATE fees
```

```
ADDRESS|0|0|1
This example sets the address to require a `MEMO` on any received `SEND`
```

## `FEE_PREFERENCE` Options
- `1` = `FEE` is destroyed, lowering supply
- `2` = `FEE` to donated to protocol development (default)
- `3` = `FEE` to donated to community development

## Rules

## Notes
- `ADDR` `ACTION` can be used for shorter reference to `ADDRESS` `ACTION`