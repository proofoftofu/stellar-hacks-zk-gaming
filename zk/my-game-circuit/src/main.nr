// my_game Noir circuit for Mastermind-like feedback checks.
// Public inputs are ordered to match on-chain checks:
// session_id, guess_id, commitment, guess_packed, exact, partial.
//
// Security note:
// `commitment` is now a salted hash commitment, not a direct packing of `secret`.
// This prevents recovering the answer from on-chain commitment bytes.

fn main(
    session_id: pub Field,
    guess_id: pub Field,
    commitment: pub Field,
    guess_packed: pub Field,
    exact: pub Field,
    partial: pub Field,
    salt: [u8; 16],
    secret: [Field; 4],
    guess: [Field; 4],
) {
    // Keep domain-separator public inputs bound into the proof.
    // (No extra inequality checks needed for Field.)
    let _sid = session_id;
    let _gid = guess_id;

    // Digits in [1, 6] using constrained cast via u8.
    for i in 0..4 {
        let g_u8: u8 = guess[i] as u8;
        let s_u8: u8 = secret[i] as u8;
        assert(g_u8 as Field == guess[i]);
        assert(s_u8 as Field == secret[i]);
        assert(g_u8 > 0);
        assert(s_u8 > 0);
        assert(g_u8 < 7);
        assert(s_u8 < 7);
    }

    // Bind guess bytes to the packed u32-style value.
    let packed_guess =
        guess[0] * 16777216 + // 256^3
        guess[1] * 65536 +    // 256^2
        guess[2] * 256 +      // 256^1
        guess[3];             // 256^0
    assert(guess_packed == packed_guess);

    // One-way salted commitment over witness values:
    // commitment = be31(blake2s(secret_bytes || salt_bytes))
    // where be31 packs the first 31 digest bytes as a field.
    let mut preimage: [u8; 20] = [0; 20];
    for i in 0..4 {
        preimage[i] = secret[i] as u8;
    }
    for i in 0..16 {
        preimage[4 + i] = salt[i];
    }
    let digest = std::hash::blake2s(preimage);
    let mut secret_commitment = 0;
    for i in 0..31 {
        secret_commitment = secret_commitment * 256 + (digest[i] as Field);
    }
    assert(commitment == secret_commitment);

    // Exact matches: correct digit in correct slot.
    let mut ex = 0;
    for i in 0..4 {
        if secret[i] == guess[i] {
            ex += 1;
        }
    }

    // Total matches by color counts, then derive partial.
    let mut total_matches = 0;
    for d in 1..7 {
        let dv = d as Field;
        let mut secret_count = 0;
        let mut guess_count = 0;
        for i in 0..4 {
            if secret[i] == dv {
                secret_count += 1;
            }
            if guess[i] == dv {
                guess_count += 1;
            }
        }
        if secret_count < guess_count {
            total_matches += secret_count;
        } else {
            total_matches += guess_count;
        }
    }
    let pa = total_matches - ex;

    assert(exact == ex as Field);
    assert(partial == pa as Field);
}
