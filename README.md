## ZK Mastermind

ZK Mastermind is a zk-based on-chain Mastermind game built from Stellar Game Studio and run on Stellar localnet.

- `player1` sets a secret 4-color code (any order).
- `player2` tries to guess the code within 4 attempts.
- ZK proof verifies that `player1`'s feedback (`exact` and `partial`) is correct.
- Feedback is verified without revealing the secret answer.

### How It Works
- `player1` commits a **salted hash commitment** of the secret code on-chain.
- `player2` submits guesses on-chain.
- `player1` computes feedback `(exact, partial)` off-chain and generates a ZK proof.
- Contract verifies:
  - public inputs match on-chain state (`session_id`, `guess_id`, `commitment`, `guess`, `exact`, `partial`)
  - proof is valid against stored VK
- If `exact == 4`, `player2` wins; otherwise after 4 attempts, `player1` wins.

Notes:
- The secret is not revealed; only feedback is public.
- Proof generation is runtime (no pre-generated `my-game.proof` / `my-game.public_inputs` needed).

### Prerequisites
- `bun`
- `stellar` CLI
- `nargo` in PATH
- `bb` in PATH

Recommended check:
```bash
nargo --version
bb --version
```

If `bb`/`nargo` versions are mismatched, proving may fail.

Tested toolchain in this repo:
- `nargo`: `1.0.0-beta.9`
- `noirc`: `1.0.0-beta.9+6abff2f16e1c1314ba30708d1cf032a536de3d19`
- `bb`: `v0.87.0`

### Repo Setup
After cloning, initialize submodules:
```bash
git submodule update --init --recursive
```

### Start Localnet First
Before setup/deploy/tests, start local Soroban network:
```bash
stellar container start local --limits unlimited
```

### One-Time Setup (VK)
From repo root:
```bash
cd zk/my-game-circuit
nargo compile
bb write_vk -b target/my_game.json -o target --scheme ultra_honk --oracle_hash keccak
cp target/vk public/my-game.vk
cd ../../
```

Then deploy/configure local network:
```bash
bun run setup:local
```

### Runtime Test Commands
From repo root:
```bash
bun run test:proof:valid
```
- Runs one valid runtime proof flow (`nargo execute` + `bb prove` inside script).

```bash
bun run test:integrate
```
- Runs full scenarios:
  - solve path: `player2` wins
  - fail path: 4 misses -> `player1` wins
  - security checks (invalid / tampered submissions rejected)

### Quick Dev Flow
From repo root:
```bash
bun run setup:local
bun run test:proof:valid
bun run test:integrate
```
