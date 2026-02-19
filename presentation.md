---
marp: true
theme: default
paginate: true
size: 16:9
title: ZK Mastermind on Stellar
---

<style>
section {
  background:
    linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px),
    #0f172a;
  background-size: 40px 40px;
  color: #e2e8f0;
  padding: 60px;
}

h1 {
  color: #818cf8;
  font-size: 56px;
}

h2 {
  color: #38bdf8;
}

code {
  background: #1e293b;
  border-radius: 6px;
  padding: 0.2em 0.4em;
}

img {
  border-radius: 16px;
}
</style>

# ZK Mastermind on Stellar
### Trustless feedback proof for Codemaker vs Codebreaker

- Built with Stellar Game Studio
- On-chain game state + zk-verified feedback
- Localnet-ready demo

---

# Problem

- In Mastermind, Codemaker knows the secret.
- Codebreaker needs correct feedback (`exact`, `partial`) each round.
- Without verification, Codemaker can lie.

Goal:
- Prove feedback is correct without revealing the secret code.

---

# Solution

- Codemaker commits a salted hash of the secret on-chain.
- Codebreaker submits guesses on-chain.
- Codemaker generates zk proof for feedback correctness.
- Contract verifies:
  - public inputs match game state
  - proof is valid under stored VK

Result:
- Trustless feedback, secret remains hidden.

---

# Game Rules

- Secret/guess length: 4
- Digit space: `1..6`
- Duplicates: allowed
- Max rounds: 12
- Win condition:
  - `exact == 4` => Codebreaker wins
  - otherwise after 12 rounds => Codemaker wins

---

# Demo UI (Codemaker)

![w:1100](./assets/codemaker.png)

---

# Demo UI (Codebreaker)

![w:1100](./assets/codebreaker.png)

---

# Architecture

- `contracts/my-game`: game contract + verifier call
- `contracts/ultrahonk-soroban-contract`: on-chain UltraHonk verifier
- `zk/my-game-circuit`: Noir circuit + VK/proof artifacts
- `my-game-frontend`: auth flow + board UI + runtime proof client
- `my-game-frontend/src/scripts/zk-server.ts`: runtime proving service

---

# Sequence Diagram

![w:1100](./assets/sequence.png)

---

# End-to-End Flow

1. Auth entry setup (Codemaker -> Codebreaker)
2. `start_game` on-chain
3. Codemaker sets commitment (`commit_code`)
4. Codebreaker submits guess (`submit_guess`)
5. Codemaker proves feedback (`submit_feedback_proof`)
6. Contract updates state / winner / end_game

---

# ZK Public Inputs

Bound public inputs:
- `session_id`
- `guess_id`
- `commitment`
- `guess`
- `exact`
- `partial`

Proof is accepted only if:
- inputs match on-chain state
- verifier validates proof with stored VK

---

# Security Notes

- Secret is never posted on-chain.
- Commitment is salted and one-way.
- Invalid/tampered proofs are rejected.
- Wrong feedback claims fail proving/verification.
- Contract enforces round limit and role-based actions.
