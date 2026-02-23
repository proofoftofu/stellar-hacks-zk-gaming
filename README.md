# ZK Mastermind on Steller

[!screen](./assets/screen.png)

ZK Mastermind is a zk-based on-chain Mastermind game built from Stellar Game Studio and run on Stellar localnet.

- `Codemaker` sets a secret 4-color code (any order).
- `Codebreaker` tries to guess the code within 12 attempts.
- ZK proof verifies that `Codemaker`'s feedback (`exact` and `partial`) is correct.
- Feedback is verified without revealing the secret answer.
- Current rule: 4 digits in `1..6`, duplicates allowed.
- Search space with duplicates allowed: `6^4 = 1296`.

## Live App
https://stellar-hacks-zk-gaming.vercel.app

## Demo
https://youtu.be/5Pb5MpLzIqw

## How It Works
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

[!screen](./assets/screen.png)

## On-chain Info

### Deployed Contract
https://stellar.expert/explorer/testnet/contract/CDQ24FKWNTKSC2LHYONS47Q2KUBOV2BD4LE32UN3XSLGYOLO5JBAT5OR

### Onchain zk proof verification tx
https://stellar.expert/explorer/testnet/tx/3d40675fa816cbc596f95f7d3e789871cbaff819b2b7764b00e21d3026f812c2

### Development Note

Project is created with:
https://jamesbachini.github.io/Stellar-Game-Studio/

On-chain ZK verifier is forked from:
https://github.com/tupui/ultrahonk_soroban_contract

- The contract has been replaced with the latest version based on the feedback provided in Discord.
