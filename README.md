## ZK Mastermind

ZK Mastermind is a zk-based on-chain Mastermind game built from Stellar Game Studio and run on Stellar localnet.

- `Codemaker` sets a secret 4-color code (any order).
- `Codebreaker` tries to guess the code within 12 attempts.
- ZK proof verifies that `Codemaker`'s feedback (`exact` and `partial`) is correct.
- Feedback is verified without revealing the secret answer.
- Current rule: 4 digits in `1..6`, duplicates allowed.
- Search space with duplicates allowed: `6^4 = 1296`.

### Demo
https://youtu.be/5Pb5MpLzIqw

### How It Works
- `Codemaker` commits a **salted hash commitment** of the secret code on-chain.
- `Codebreaker` submits guesses on-chain.
- `Codemaker` computes feedback `(exact, partial)` off-chain and generates a ZK proof.
- Contract verifies:
  - public inputs match on-chain state (`session_id`, `guess_id`, `commitment`, `guess`, `exact`, `partial`)
  - proof is valid against stored VK
- If `exact == 4`, `Codebreaker` wins; otherwise after 12 attempts, `Codemaker` wins.

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

### Test Commands
From repo root:
```bash
bun run test:integrate
```
- Runs full scenarios:
  - solve path: `Codebreaker` wins
  - fail path: 12 misses -> `Codemaker` wins
  - security checks (invalid / tampered submissions rejected)

### Run Frontend + ZK Server (Local)
From repo root:

1) Resolve binary paths and export for zk-server:
```bash
which nargo
which bb

export NARGO_BIN="$(which nargo)"
export BB_BIN="$(which bb)"
```

2) Start zk proof server (terminal A):
```bash
bun run zk:server
```

3) Start game frontend (terminal B):
```bash
bun run dev:game my-game
```

Notes:
- `zk-server` defaults to `http://localhost:8787`
- frontend uses `VITE_ZK_SERVER_URL` if set, otherwise it also defaults to `http://localhost:8787`

### Development Note

Project is created with:
https://jamesbachini.github.io/Stellar-Game-Studio/

On-chain ZK verifier is forked from:
https://github.com/tupui/ultrahonk_soroban_contract

### Limitation

I could not run the ZK verifier on Testnet because of budget limit issues, so the submitted project runs on local only.
