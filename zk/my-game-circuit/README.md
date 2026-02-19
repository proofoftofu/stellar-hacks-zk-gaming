# my-game Noir Circuit

This circuit is a minimal Mastermind-style relation with public inputs:

1. `session_id`
2. `guess_id`
3. `commitment`
4. `guess_packed`
5. `exact`
6. `partial`

It currently uses a simple packed commitment (`secret` packed as 4 bytes), not keccak.

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
- `commitment = 16909060` (packed `0x01020304`)
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
  --oracle_hash keccak \
  --output_format bytes_and_fields
```

Expected VK file:
- `target/vk_fields.json`

## 6) Generate proof

```bash
bb prove \
  -b target/my_game.json \
  -w target/my_game.gz \
  -o target \
  --scheme ultra_honk \
  --oracle_hash keccak \
  --output_format bytes_and_fields
```

This writes proof artifacts under `target/` (format depends on bb version).

## 7) Optional: also produce `my-game.json` file name

```bash
cp target/my_game.json target/my-game.json
```
