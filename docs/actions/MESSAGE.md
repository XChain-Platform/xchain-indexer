#  XChain Platform Action - MESSAGE
This action allows for the sending of plaintext and encrypted messages between addresses.

## PARAMS
| Name                | Type   | Description                                |
| ------------------- | ------ | ------------------------------------------ |
| `VERSION`           | String | Broadcast Format Version                   |
| `DESTINATION`       | String | Address of the message or key recipient    |
| `ENCRYPTION_METHOD` | String | Encryption Method (1=ECDH, 2=AES)          |
| `ENCRYPTION_KEY`    | String | public key to be used to exchange messages |
| `ENCRYPTED_MESSAGE` | String | Message encryted with shared key           |
| `PLAINTEXT_MESSAGE` | String | Plaintext message (visible to all!)        |

## Formats

### Version `0` - Sender Key
- `VERSION|DESTINATION|ENCRYPTION_METHOD|ENCRYPTION_KEY`

### Version `1` - Receiver Key
- `VERSION|DESTINATION|ENCRYPTION_METHOD|ENCRYPTION_KEY`

### Version `2` - Encrypted Message
- `VERSION|DESTINATION|ENCRYPTED_MESSAGE`

### Version `3` - Plaintext Message
- `VERSION|DESTINATION|PLAINTEXT_MESSAGE`

## Examples
```
MESSAGE|0|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1|PUBLIC_KEY_GOES_HERE
This example requests to securely exchange messages with address 1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev
```

```
MESSAGE|1|1Donatet2LrNpuWByAnH8gc9Wh9zSzZuLC|1|PUBLIC_KEY_GOES_HERE
This example responds to the above request to securely exchange messages with address 1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev
```

```
MESSAGE|2|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|ENCRYPTED_MESSAGE_GOES_HERE
This example send an encrypted message to 1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev
```

```
MESSAGE|3|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|Hello
This example send a plaintext message to 1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev
```

## Rules
- `ENCRYPTION_METHOD`, `ENCRYPTED_MESSAGE`, and `PLAINTEXT_MESSAGE` are limited to 1,048,576 Characters (1MB)

## Notes
- `MSG` `ACTION` can be used for shorter reference to `MESSAGE` `ACTION`
- Format `0` is to be used when first initializing a request
- Format `1` is to be used when responding to an initializing request 
- `PLAINTEXT_MESSAGE` and `ENCRYPTED_MESSAGE` characters **NOT** allowed are :
   - pipe `|` (used as field separator)
   - semicolon `;` (used as command separator)

