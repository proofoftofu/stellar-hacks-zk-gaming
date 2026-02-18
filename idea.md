# Selected Idea
ZK Mastermind Duel: Player A commits to a secret 4-color code, Player B gets up to 4 guesses, and Player A must submit proof-backed feedback (`exact match`, `partial match`) so feedback is verifiably correct without revealing the secret code.

## Why This Can Win
- ZK is essential to the core mechanic: hidden code stays private while every feedback response is provably honest.
- Judge-friendly demo: one clear trust problem (“host can lie about hints”) solved live with proof verification.
- Strong fit for Stellar ZK track plus required onchain lifecycle (`start_game` / `end_game`).

## Feasibility Balance
- Build from the existing `number-guess`/`my-game` contract pattern instead of greenfield architecture.
- Keep one match session with capped attempts (`max_attempts = 4`) and deterministic state transitions.
- Tradeoff: focus on one polished ZK feedback mechanic; skip extra game modes and social features.

## Core Features
- Secret commitment: Player A commits to hashed code at game start.
- Guess + proof-feedback loop: Player B submits guess; Player A submits `(exact, partial)` plus proof tied to commitment and guess.
- Automatic match finalization: contract calls `end_game` when solved or attempts are exhausted.

## Tech Stack
- Soroban contract in Rust under `workspace/contracts/my-game` (adapted from current guess flow).
- Stellar Game Hub integration for lifecycle and settlement (`start_game`, `end_game`).
- Existing frontend/bindings flow from the studio scaffold for two-player interaction and feedback display.

## Step-by-Step Plan
1. Refactor `workspace/contracts/my-game/src/lib.rs` from single guess winner logic to Mastermind state (`commitment`, `attempt_count`, guess/feedback history).
2. Add methods: `commit_code`, `submit_guess`, `submit_feedback_proof`, and terminal logic for `solved || attempts >= 4`.
3. Keep lifecycle atomic on terminal paths using `end_game` call, then winner/ended state persist.
4. Update tests in `workspace/contracts/my-game/src/test.rs` for 4-attempt cap, correct-proof acceptance, invalid-proof rejection, and single-settlement behavior.

## Prototype Specs (Only Required Components)

### `my-game` Mastermind Contract
- Type: blockchain
- Required: yes
- Goal: enforce private-code gameplay with verifiable feedback correctness.
- Scope: implement directly inside `hackathons/2026-02-24_stellar-hacks-zk-gaming/workspace/contracts/my-game/` (no separate prototype folder).
- Unit Test Target: `submit_guess`, `submit_feedback_proof`, terminal condition + `end_game` path.
- Integration Contract: `start_game(session_id, player1, player2, player1_points, player2_points)`, `commit_code(session_id, commitment)`, `submit_guess(session_id, guess)`, `submit_feedback_proof(session_id, guess_id, exact, partial, proof, public_inputs)`, `end_game(session_id, player1_won)`.

### `my-game` Frontend/Bindings Update
- Type: web
- Required: yes
- Goal: show clear two-player flow: commit -> guess -> proof-backed feedback -> solved/failed outcome.
- Scope: wire existing generated bindings/service/UI for `my-game` only; no extra app surfaces.
- Unit Test Target: client state transitions for attempts remaining, feedback rendering, and terminal lock.
- Integration Contract: consumes `my-game` methods and renders proof-validation result for each attempt.
