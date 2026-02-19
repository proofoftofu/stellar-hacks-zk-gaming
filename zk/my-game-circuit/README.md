# my-game Noir Circuit

This circuit is a minimal Mastermind-style relation with public inputs:

1. `session_id`
2. `guess_id`
3. `commitment`
4. `guess_packed`
5. `exact`
6. `partial`

It uses a salted one-way commitment:
- `commitment = be31(blake2s(secret_bytes || salt_bytes))`
- `secret` and `guess` are 4 unique digits in `1..6`

## 0) Prerequisites

Install Noir + Barretenberg (`nargo`, `bb`) first.

## 1) Move into this circuit folder

```bash
cd zk/my-game-circuit
```

## 2) Edit proving inputs

Update `Prover.toml` to match your test session values.

For the included sample:
- `secret = [1,2,3,4]`
- `guess = [1,2,3,4]`
- `commitment = <decimal field value from blake2s(secret||salt)>`
- `guess_packed = 16909060`
- `exact = 4`, `partial = 0`

## 3) Compile

```bash
nargo compile
```

Expected artifact:
- `target/my_game.json`

## 4) Execute witness generation

```bash
nargo execute
```

Expected witness:
- `target/my_game.gz`

## 5) Generate verification key

```bash
bb write_vk \
  -b target/my_game.json \
  -o target \
  --scheme ultra_honk \
  --oracle_hash keccak
```

Expected VK file:
- `target/vk`

## 6) Generate proof

```bash
bb prove \
  -b target/my_game.json \
  -w target/my_game.gz \
  -o target \
  --scheme ultra_honk \
  --oracle_hash keccak
```

This writes proof artifacts under `target/` (format depends on bb version).

## 7) Optional: also produce `my-game.json` file name

```bash
cp target/my_game.json target/my-game.json
```
