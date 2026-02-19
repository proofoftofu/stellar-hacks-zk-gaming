#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, vec, Address, Bytes,
    BytesN, Env, IntoVal, Vec,
};

#[contractclient(name = "GameHubClient")]
pub trait GameHub {
    fn start_game(
        env: Env,
        game_id: Address,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    );

    fn end_game(env: Env, session_id: u32, player1_won: bool);
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VerifierError {
    VkParseError = 1,
    ProofParseError = 2,
    VerificationFailed = 3,
    VkNotSet = 4,
}

#[contractclient(name = "UltraHonkVerifierClient")]
pub trait UltraHonkVerifier {
    fn verify_proof_with_stored_vk(env: Env, proof_blob: Bytes) -> Result<BytesN<32>, VerifierError>;
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    GameNotFound = 1,
    NotPlayer = 2,
    GameAlreadyEnded = 3,
    CommitmentAlreadySet = 4,
    CommitmentNotSet = 5,
    GuessPendingFeedback = 6,
    NoPendingGuess = 7,
    InvalidGuessId = 8,
    InvalidFeedback = 9,
    InvalidPublicInputs = 10,
    InvalidProof = 11,
    AttemptsExhausted = 12,
    VerifierNotSet = 13,
    InvalidProofBlob = 14,
    InvalidGuess = 15,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuessRecord {
    pub guess_id: u32,
    pub guess: BytesN<4>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedbackRecord {
    pub guess_id: u32,
    pub exact: u32,
    pub partial: u32,
    pub proof_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Game {
    pub player1: Address,
    pub player2: Address,
    pub player1_points: i128,
    pub player2_points: i128,
    pub commitment: Option<BytesN<32>>,
    pub max_attempts: u32,
    pub attempts_used: u32,
    pub next_guess_id: u32,
    pub pending_guess_id: Option<u32>,
    pub guesses: Vec<GuessRecord>,
    pub feedbacks: Vec<FeedbackRecord>,
    pub winner: Option<Address>,
    pub solved: bool,
    pub ended: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Game(u32),
    GameHubAddress,
    Admin,
    VerifierAddress,
}

const GAME_TTL_LEDGERS: u32 = 518_400;
const MAX_ATTEMPTS: u32 = 12;

#[contract]
pub struct MyGameContract;

#[contractimpl]
impl MyGameContract {
    pub fn __constructor(env: Env, admin: Address, game_hub: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::GameHubAddress, &game_hub);
    }

    pub fn start_game(
        env: Env,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    ) -> Result<(), Error> {
        if player1 == player2 {
            panic!("Cannot play against yourself: Player 1 and Player 2 must be different addresses");
        }

        player1.require_auth_for_args(vec![
            &env,
            session_id.into_val(&env),
            player1_points.into_val(&env),
        ]);
        player2.require_auth_for_args(vec![
            &env,
            session_id.into_val(&env),
            player2_points.into_val(&env),
        ]);

        let game_hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub address not set");
        let game_hub = GameHubClient::new(&env, &game_hub_addr);

        game_hub.start_game(
            &env.current_contract_address(),
            &session_id,
            &player1,
            &player2,
            &player1_points,
            &player2_points,
        );

        let game = Game {
            player1,
            player2,
            player1_points,
            player2_points,
            commitment: None,
            max_attempts: MAX_ATTEMPTS,
            attempts_used: 0,
            next_guess_id: 0,
            pending_guess_id: None,
            guesses: Vec::new(&env),
            feedbacks: Vec::new(&env),
            winner: None,
            solved: false,
            ended: false,
        };

        Self::write_game(&env, session_id, &game);
        Ok(())
    }

    pub fn commit_code(env: Env, session_id: u32, commitment: BytesN<32>) -> Result<(), Error> {
        let mut game = Self::load_game(&env, session_id)?;
        if game.ended {
            return Err(Error::GameAlreadyEnded);
        }
        game.player1.require_auth();
        if game.commitment.is_some() {
            return Err(Error::CommitmentAlreadySet);
        }

        game.commitment = Some(commitment);
        Self::write_game(&env, session_id, &game);
        Ok(())
    }

    pub fn submit_guess(env: Env, session_id: u32, guess: BytesN<4>) -> Result<u32, Error> {
        let mut game = Self::load_game(&env, session_id)?;
        if game.ended {
            return Err(Error::GameAlreadyEnded);
        }
        if game.commitment.is_none() {
            return Err(Error::CommitmentNotSet);
        }
        if game.attempts_used >= game.max_attempts {
            return Err(Error::AttemptsExhausted);
        }
        if game.pending_guess_id.is_some() {
            return Err(Error::GuessPendingFeedback);
        }

        game.player2.require_auth();
        Self::validate_guess_digits(&guess)?;

        let guess_id = game.next_guess_id;
        game.next_guess_id += 1;
        game.pending_guess_id = Some(guess_id);
        game.guesses.push_back(GuessRecord { guess_id, guess });

        Self::write_game(&env, session_id, &game);
        Ok(guess_id)
    }

    pub fn submit_feedback_proof(
        env: Env,
        session_id: u32,
        guess_id: u32,
        exact: u32,
        partial: u32,
        proof_blob: Bytes,
    ) -> Result<(), Error> {
        let mut game = Self::load_game(&env, session_id)?;
        if game.ended {
            return Err(Error::GameAlreadyEnded);
        }
        game.player1.require_auth();

        let commitment = game.commitment.clone().ok_or(Error::CommitmentNotSet)?;
        let pending_guess_id = game.pending_guess_id.ok_or(Error::NoPendingGuess)?;
        if pending_guess_id != guess_id {
            return Err(Error::InvalidGuessId);
        }
        if exact > 4 || partial > 4 || exact + partial > 4 {
            return Err(Error::InvalidFeedback);
        }

        let guess = Self::guess_by_id(&game, guess_id).ok_or(Error::InvalidGuessId)?;
        let expected_public_inputs =
            Self::build_public_inputs(&env, session_id, guess_id, &commitment, &guess, exact, partial);
        let public_inputs = Self::extract_public_inputs_from_proof_blob(&env, &proof_blob)?;
        if expected_public_inputs != public_inputs {
            return Err(Error::InvalidPublicInputs);
        }

        let verifier_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::VerifierAddress)
            .ok_or(Error::VerifierNotSet)?;
        let verifier = UltraHonkVerifierClient::new(&env, &verifier_addr);
        match verifier.try_verify_proof_with_stored_vk(&proof_blob) {
            Ok(Ok(_proof_id)) => {}
            _ => return Err(Error::InvalidProof),
        }

        let proof_hash = env.crypto().keccak256(&proof_blob);
        game.feedbacks.push_back(FeedbackRecord {
            guess_id,
            exact,
            partial,
            proof_hash: proof_hash.into(),
        });
        game.pending_guess_id = None;
        game.attempts_used += 1;

        if exact == 4 {
            let game_hub_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::GameHubAddress)
                .expect("GameHub address not set");
            let game_hub = GameHubClient::new(&env, &game_hub_addr);
            game_hub.end_game(&session_id, &false);
            game.solved = true;
            game.ended = true;
            game.winner = Some(game.player2.clone());
        } else if game.attempts_used >= game.max_attempts {
            let game_hub_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::GameHubAddress)
                .expect("GameHub address not set");
            let game_hub = GameHubClient::new(&env, &game_hub_addr);
            game_hub.end_game(&session_id, &true);
            game.solved = false;
            game.ended = true;
            game.winner = Some(game.player1.clone());
        }

        Self::write_game(&env, session_id, &game);
        Ok(())
    }

    pub fn get_game(env: Env, session_id: u32) -> Result<Game, Error> {
        Self::load_game(&env, session_id)
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set")
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn get_hub(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub address not set")
    }

    pub fn set_hub(env: Env, new_hub: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::GameHubAddress, &new_hub);
    }

    pub fn get_verifier(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::VerifierAddress)
    }

    pub fn set_verifier(env: Env, verifier: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.storage().instance().set(&DataKey::VerifierAddress, &verifier);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    fn load_game(env: &Env, session_id: u32) -> Result<Game, Error> {
        let game_key = DataKey::Game(session_id);
        env.storage()
            .temporary()
            .get(&game_key)
            .ok_or(Error::GameNotFound)
    }

    fn write_game(env: &Env, session_id: u32, game: &Game) {
        let game_key = DataKey::Game(session_id);
        env.storage().temporary().set(&game_key, game);
        env.storage()
            .temporary()
            .extend_ttl(&game_key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);
    }

    fn guess_by_id(game: &Game, guess_id: u32) -> Option<BytesN<4>> {
        let mut i = 0;
        while i < game.guesses.len() {
            let record = game.guesses.get(i).unwrap();
            if record.guess_id == guess_id {
                return Some(record.guess);
            }
            i += 1;
        }
        None
    }

    fn validate_guess_digits(guess: &BytesN<4>) -> Result<(), Error> {
        let d0 = guess.get(0).unwrap_or(0);
        let d1 = guess.get(1).unwrap_or(0);
        let d2 = guess.get(2).unwrap_or(0);
        let d3 = guess.get(3).unwrap_or(0);

        for d in [d0, d1, d2, d3] {
            if !(1..=6).contains(&d) {
                return Err(Error::InvalidGuess);
            }
        }

        if d0 == d1 || d0 == d2 || d0 == d3 || d1 == d2 || d1 == d3 || d2 == d3 {
            return Err(Error::InvalidGuess);
        }
        Ok(())
    }

    fn build_public_inputs(
        env: &Env,
        session_id: u32,
        guess_id: u32,
        commitment: &BytesN<32>,
        guess: &BytesN<4>,
        exact: u32,
        partial: u32,
    ) -> Bytes {
        let mut public_inputs = Bytes::new(env);
        Self::append_u32_field(env, &mut public_inputs, session_id);
        Self::append_u32_field(env, &mut public_inputs, guess_id);
        public_inputs.append(&commitment.to_bytes());
        Self::append_bytes4_field(env, &mut public_inputs, guess);
        Self::append_u32_field(env, &mut public_inputs, exact);
        Self::append_u32_field(env, &mut public_inputs, partial);
        public_inputs
    }

    fn append_u32_field(env: &Env, out: &mut Bytes, value: u32) {
        let mut field = [0u8; 32];
        field[28..32].copy_from_slice(&value.to_be_bytes());
        out.append(&Bytes::from_array(env, &field));
    }

    fn append_bytes4_field(env: &Env, out: &mut Bytes, value: &BytesN<4>) {
        let mut field = [0u8; 32];
        field[28] = value.get(0).unwrap();
        field[29] = value.get(1).unwrap();
        field[30] = value.get(2).unwrap();
        field[31] = value.get(3).unwrap();
        out.append(&Bytes::from_array(env, &field));
    }

    fn extract_public_inputs_from_proof_blob(_env: &Env, proof_blob: &Bytes) -> Result<Bytes, Error> {
        let total_len = proof_blob.len();
        if total_len < 4 {
            return Err(Error::InvalidProofBlob);
        }

        let rest_len = total_len - 4;
        for proof_fields in [456u32, 440u32, 234u32] {
            let proof_len = proof_fields * 32;
            if rest_len >= proof_len {
                let pi_len = rest_len - proof_len;
                if pi_len % 32 == 0 {
                    return Ok(proof_blob.slice(4..(4 + pi_len)));
                }
            }
        }

        Err(Error::InvalidProofBlob)
    }
}

#[cfg(test)]
mod test;
