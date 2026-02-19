# Selected Idea (Implemented)
ZK Mastermind Duel on Stellar: `player1` commits to a hidden 4-digit code, `player2` has up to 4 guesses, and `player1` must submit proof-backed feedback (`exact`, `partial`) that verifies on-chain without revealing the secret.

## Actual Security Model
- Secret is hidden by commitment, not stored in plaintext.
- Current circuit commitment is salted one-way hash style (`blake2s(secret || salt)` reduced to a field value used as on-chain commitment).
- For each guess, proof binds these public inputs:
  - `session_id`
  - `guess_id`
  - `commitment`
  - `guess`
  - `exact`
  - `partial`
- Contract recomputes expected public input bytes from on-chain state and rejects if mismatched.
- Verifier then checks UltraHonk proof against stored VK.

## Actual On-Chain Flow
1. `start_game(session_id, player1, player2, player1_points, player2_points)`
2. `commit_code(session_id, commitment)` by `player1`
3. `submit_guess(session_id, guess)` by `player2`
4. `submit_feedback_proof(session_id, guess_id, exact, partial, proof_blob)` by `player1`
5. Repeat 3-4 until terminal condition:
   - if `exact == 4` on feedback submit: `player2` wins and `end_game(..., player1_won=false)`
   - else if attempts reach 4: `player1` wins and `end_game(..., player1_won=true)`

## Why This Matters
- Solves the core trust problem: host cannot lie about feedback.
- Keeps the secret private while making feedback correctness publicly verifiable.
- Strong fit with Stellar Game Studio lifecycle (`start_game` / `end_game`) and ZK judging criteria.

## Current Implementation Scope
- Contract: `contracts/my-game`
  - methods: `start_game`, `commit_code`, `submit_guess`, `submit_feedback_proof`, `get_game`
  - verifier wiring: `set_verifier`, `get_verifier`
- Verifier contract source: `zk/ultrahonk_soroban_contract/contracts/ultrahonk-soroban-contract`
- Circuit: `zk/my-game-circuit`
- Runtime proving scripts:
  - `my-game-frontend/src/scripts/test-proof.ts` (single flow)
  - `my-game-frontend/src/scripts/integrate.ts` (multi-scenario incl. security rejections)

## Testing Targets (Current)
- Happy paths:
  - solved path (`player2` wins)
  - 4-attempt fail path (`player1` wins)
- Security paths:
  - invalid/tampered proof rejected
  - wrong `guess_id` rejected
  - forged feedback fields rejected
  - double guess while pending feedback rejected
  - prover cannot generate proof for deliberately false feedback
