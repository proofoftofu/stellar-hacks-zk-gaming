#![cfg(test)]

use crate::{Error, MyGameContract, MyGameContractClient, VerifierError};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, BytesN, Env};

#[contract]
pub struct MockGameHub;

#[contracttype]
#[derive(Clone)]
pub enum HubDataKey {
    EndCount(u32),
    LastOutcome(u32),
}

#[contractimpl]
impl MockGameHub {
    pub fn start_game(
        _env: Env,
        _game_id: Address,
        _session_id: u32,
        _player1: Address,
        _player2: Address,
        _player1_points: i128,
        _player2_points: i128,
    ) {
    }

    pub fn end_game(env: Env, session_id: u32, player1_won: bool) {
        let count_key = HubDataKey::EndCount(session_id);
        let count: u32 = env.storage().instance().get(&count_key).unwrap_or(0);
        env.storage().instance().set(&count_key, &(count + 1));
        env.storage()
            .instance()
            .set(&HubDataKey::LastOutcome(session_id), &player1_won);
    }

    pub fn add_game(_env: Env, _game_address: Address) {}

    pub fn get_end_count(env: Env, session_id: u32) -> u32 {
        env.storage()
            .instance()
            .get(&HubDataKey::EndCount(session_id))
            .unwrap_or(0)
    }

    pub fn get_last_outcome(env: Env, session_id: u32) -> Option<bool> {
        env.storage().instance().get(&HubDataKey::LastOutcome(session_id))
    }
}

#[contract]
pub struct MockUltraHonkVerifier;

#[contractimpl]
impl MockUltraHonkVerifier {
    pub fn verify_proof_with_stored_vk(env: Env, proof_blob: Bytes) -> Result<BytesN<32>, VerifierError> {
        let len = proof_blob.len();
        if len < (4 + (440 * 32)) as u32 {
            return Err(VerifierError::ProofParseError);
        }
        if proof_blob.get(len - 1).unwrap_or(0) == 0 {
            return Err(VerifierError::VerificationFailed);
        }
        Ok(env.crypto().keccak256(&proof_blob).into())
    }
}

fn setup_test() -> (
    Env,
    MyGameContractClient<'static>,
    MockGameHubClient<'static>,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: 1441065600,
        protocol_version: 25,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: u32::MAX / 2,
        min_persistent_entry_ttl: u32::MAX / 2,
        max_entry_ttl: u32::MAX / 2,
    });

    let hub_addr = env.register(MockGameHub, ());
    let verifier_addr = env.register(MockUltraHonkVerifier, ());
    let game_hub = MockGameHubClient::new(&env, &hub_addr);

    let admin = Address::generate(&env);
    let contract_id = env.register(MyGameContract, (&admin, &hub_addr));
    let client = MyGameContractClient::new(&env, &contract_id);
    client.set_verifier(&verifier_addr);

    game_hub.add_game(&contract_id);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);

    (env, client, game_hub, player1, player2)
}

fn setup_test_without_verifier() -> (Env, MyGameContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: 1441065600,
        protocol_version: 25,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: u32::MAX / 2,
        min_persistent_entry_ttl: u32::MAX / 2,
        max_entry_ttl: u32::MAX / 2,
    });

    let hub_addr = env.register(MockGameHub, ());
    let admin = Address::generate(&env);
    let contract_id = env.register(MyGameContract, (&admin, &hub_addr));
    let client = MyGameContractClient::new(&env, &contract_id);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    (env, client, player1, player2)
}

fn assert_game_error<T, E>(
    result: &Result<Result<T, E>, Result<Error, soroban_sdk::InvokeError>>,
    expected_error: Error,
) {
    match result {
        Err(Ok(actual_error)) => assert_eq!(*actual_error, expected_error),
        _ => panic!("expected contract error"),
    }
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
    let mut out = Bytes::new(env);
    append_u32_field(env, &mut out, session_id);
    append_u32_field(env, &mut out, guess_id);
    out.append(&commitment.to_bytes());
    append_guess_field(env, &mut out, guess);
    append_u32_field(env, &mut out, exact);
    append_u32_field(env, &mut out, partial);
    out
}

fn append_u32_field(env: &Env, out: &mut Bytes, value: u32) {
    let mut field = [0u8; 32];
    field[28..32].copy_from_slice(&value.to_be_bytes());
    out.append(&Bytes::from_array(env, &field));
}

fn append_guess_field(env: &Env, out: &mut Bytes, guess: &BytesN<4>) {
    let mut field = [0u8; 32];
    field[28] = guess.get(0).unwrap();
    field[29] = guess.get(1).unwrap();
    field[30] = guess.get(2).unwrap();
    field[31] = guess.get(3).unwrap();
    out.append(&Bytes::from_array(env, &field));
}

fn commitment_from_4bytes(env: &Env, seed: [u8; 4]) -> BytesN<32> {
    env.crypto().keccak256(&Bytes::from_array(env, &seed)).into()
}

fn build_proof_blob(env: &Env, public_inputs: &Bytes, valid: bool) -> Bytes {
    let proof_fields = 440u32;
    let pi_fields = public_inputs.len() / 32;
    let total_fields = proof_fields + pi_fields;

    let mut blob = Bytes::new(env);
    blob.append(&Bytes::from_array(env, &total_fields.to_be_bytes()));
    blob.append(public_inputs);

    let mut i = 0u32;
    let proof_bytes = proof_fields * 32;
    while i < proof_fields * 32 {
        let is_last = i == proof_bytes - 1;
        if is_last && !valid {
            blob.push_back(0u8);
        } else {
            blob.push_back(1u8);
        }
        i += 1;
    }
    blob
}

#[test]
fn test_solved_path_player2_wins_and_settles_once() {
    let (env, client, hub, player1, player2) = setup_test();
    let session_id = 1u32;
    let commitment = commitment_from_4bytes(&env, [1, 2, 3, 4]);
    let guess = BytesN::<4>::from_array(&env, &[1, 2, 3, 4]);

    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);
    client.commit_code(&session_id, &commitment);
    let guess_id = client.submit_guess(&session_id, &guess);

    let public_inputs = build_public_inputs(&env, session_id, guess_id, &commitment, &guess, 4, 0);
    let proof_blob = build_proof_blob(&env, &public_inputs, true);
    client.submit_feedback_proof(&session_id, &guess_id, &4, &0, &proof_blob);

    let game = client.get_game(&session_id);
    assert!(game.ended);
    assert!(game.solved);
    assert_eq!(game.winner, Some(player2));
    assert_eq!(hub.get_end_count(&session_id), 1);
    assert_eq!(hub.get_last_outcome(&session_id), Some(false));
}

#[test]
fn test_invalid_proof_rejected() {
    let (env, client, hub, player1, player2) = setup_test();
    let session_id = 2u32;
    let commitment = commitment_from_4bytes(&env, [9, 9, 9, 9]);
    let guess = BytesN::<4>::from_array(&env, &[1, 2, 3, 5]);

    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);
    client.commit_code(&session_id, &commitment);
    let guess_id = client.submit_guess(&session_id, &guess);

    let public_inputs = build_public_inputs(&env, session_id, guess_id, &commitment, &guess, 1, 2);
    let proof_blob = build_proof_blob(&env, &public_inputs, false);
    let result = client.try_submit_feedback_proof(&session_id, &guess_id, &1, &2, &proof_blob);
    assert_game_error(&result, Error::InvalidProof);

    let game = client.get_game(&session_id);
    assert_eq!(game.attempts_used, 0);
    assert_eq!(game.pending_guess_id, Some(guess_id));
    assert_eq!(hub.get_end_count(&session_id), 0);
}

#[test]
fn test_invalid_public_inputs_rejected() {
    let (env, client, _hub, player1, player2) = setup_test();
    let session_id = 3u32;
    let commitment = commitment_from_4bytes(&env, [4, 3, 2, 1]);
    let guess = BytesN::<4>::from_array(&env, &[1, 2, 4, 5]);

    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);
    client.commit_code(&session_id, &commitment);
    let guess_id = client.submit_guess(&session_id, &guess);

    let wrong_public_inputs = build_public_inputs(&env, session_id, guess_id, &commitment, &guess, 2, 1);
    let proof_blob = build_proof_blob(&env, &wrong_public_inputs, true);
    let result = client.try_submit_feedback_proof(&session_id, &guess_id, &1, &1, &proof_blob);
    assert_game_error(&result, Error::InvalidPublicInputs);
}

#[test]
fn test_guess_blocked_until_feedback_submitted() {
    let (env, client, _hub, player1, player2) = setup_test();
    let session_id = 4u32;
    let commitment = commitment_from_4bytes(&env, [4, 3, 2, 1]);
    let guess1 = BytesN::<4>::from_array(&env, &[1, 2, 3, 4]);
    let guess2 = BytesN::<4>::from_array(&env, &[1, 2, 3, 5]);

    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);
    client.commit_code(&session_id, &commitment);
    client.submit_guess(&session_id, &guess1);

    let result = client.try_submit_guess(&session_id, &guess2);
    assert_game_error(&result, Error::GuessPendingFeedback);
}

#[test]
fn test_submit_guess_rejects_out_of_range_or_duplicate_digits() {
    let (env, client, _hub, player1, player2) = setup_test();
    let session_id = 41u32;
    let commitment = commitment_from_4bytes(&env, [4, 3, 2, 1]);
    let duplicate_guess = BytesN::<4>::from_array(&env, &[1, 1, 2, 3]);
    let out_of_range_guess = BytesN::<4>::from_array(&env, &[1, 2, 3, 7]);

    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);
    client.commit_code(&session_id, &commitment);

    let dup_result = client.try_submit_guess(&session_id, &duplicate_guess);
    assert_game_error(&dup_result, Error::InvalidGuess);

    let range_result = client.try_submit_guess(&session_id, &out_of_range_guess);
    assert_game_error(&range_result, Error::InvalidGuess);
}

#[test]
fn test_attempt_cap_player1_wins_on_twelfth_feedback() {
    let (env, client, hub, player1, player2) = setup_test();
    let session_id = 5u32;
    let commitment = commitment_from_4bytes(&env, [8, 8, 8, 8]);

    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);
    client.commit_code(&session_id, &commitment);

    let guesses: [[u8; 4]; 12] = [
        [1, 2, 3, 5],
        [1, 2, 3, 6],
        [1, 2, 4, 5],
        [1, 2, 4, 6],
        [1, 2, 5, 6],
        [1, 3, 4, 5],
        [1, 3, 4, 6],
        [1, 3, 5, 6],
        [1, 4, 5, 6],
        [2, 3, 4, 5],
        [2, 3, 4, 6],
        [2, 3, 5, 6],
    ];

    for (idx, raw_guess) in guesses.iter().enumerate() {
        let guess = BytesN::<4>::from_array(&env, raw_guess);
        let guess_id = client.submit_guess(&session_id, &guess);
        assert_eq!(guess_id, idx as u32);
        let public_inputs = build_public_inputs(&env, session_id, guess_id, &commitment, &guess, 1, 1);
        let proof_blob = build_proof_blob(&env, &public_inputs, true);
        client.submit_feedback_proof(&session_id, &guess_id, &1, &1, &proof_blob);
    }

    let game = client.get_game(&session_id);
    assert!(game.ended);
    assert!(!game.solved);
    assert_eq!(game.winner, Some(player1));
    assert_eq!(game.attempts_used, 12);
    assert_eq!(hub.get_end_count(&session_id), 1);
    assert_eq!(hub.get_last_outcome(&session_id), Some(true));
}

#[test]
fn test_reject_wrong_guess_id() {
    let (env, client, _hub, player1, player2) = setup_test();
    let session_id = 6u32;
    let commitment = commitment_from_4bytes(&env, [5, 5, 5, 5]);
    let guess = BytesN::<4>::from_array(&env, &[1, 2, 3, 6]);

    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);
    client.commit_code(&session_id, &commitment);
    let guess_id = client.submit_guess(&session_id, &guess);

    let wrong_guess_id = guess_id + 1;
    let public_inputs = build_public_inputs(
        &env,
        session_id,
        wrong_guess_id,
        &commitment,
        &guess,
        2,
        1,
    );
    let proof_blob = build_proof_blob(&env, &public_inputs, true);
    let result = client.try_submit_feedback_proof(&session_id, &wrong_guess_id, &2, &1, &proof_blob);
    assert_game_error(&result, Error::InvalidGuessId);
}

#[test]
fn test_verifier_not_set_rejected() {
    let (env, client, player1, player2) = setup_test_without_verifier();
    let session_id = 7u32;
    let commitment = commitment_from_4bytes(&env, [7, 7, 7, 7]);
    let guess = BytesN::<4>::from_array(&env, &[1, 2, 3, 4]);

    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);
    client.commit_code(&session_id, &commitment);
    let guess_id = client.submit_guess(&session_id, &guess);
    let public_inputs = build_public_inputs(&env, session_id, guess_id, &commitment, &guess, 1, 1);
    let proof_blob = build_proof_blob(&env, &public_inputs, true);

    let result = client.try_submit_feedback_proof(&session_id, &guess_id, &1, &1, &proof_blob);
    assert_game_error(&result, Error::VerifierNotSet);
}

#[test]
fn test_cannot_commit_twice() {
    let (env, client, _hub, player1, player2) = setup_test();
    let session_id = 8u32;
    let commitment1 = commitment_from_4bytes(&env, [1, 1, 1, 1]);
    let commitment2 = commitment_from_4bytes(&env, [2, 2, 2, 2]);

    client.start_game(&session_id, &player1, &player2, &100_0000000, &100_0000000);
    client.commit_code(&session_id, &commitment1);

    let result = client.try_commit_code(&session_id, &commitment2);
    assert_game_error(&result, Error::CommitmentAlreadySet);
}

#[test]
fn test_upgrade_function_exists() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let hub_addr = env.register(MockGameHub, ());
    let contract_id = env.register(MyGameContract, (&admin, &hub_addr));
    let client = MyGameContractClient::new(&env, &contract_id);

    let new_wasm_hash = BytesN::from_array(&env, &[1u8; 32]);
    let result = client.try_upgrade(&new_wasm_hash);
    assert!(result.is_err());
}
