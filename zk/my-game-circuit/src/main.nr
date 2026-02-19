// my_game Noir circuit for Mastermind-like feedback checks.
// Public inputs are ordered to match on-chain checks:
// session_id, guess_id, commitment, guess_packed, exact, partial.

fn main(
    session_id: pub Field,
    guess_id: pub Field,
    commitment: pub Field,
    guess_packed: pub Field,
    exact: pub Field,
    partial: pub Field,
    secret: [Field; 4],
    guess: [Field; 4],
) {
    // Keep domain-separator public inputs bound into the proof.
    // (No extra inequality checks needed for Field.)
    let _sid = session_id;
    let _gid = guess_id;

    // Digits in [0, 9] using constrained cast via u8.
    for i in 0..4 {
        let g_u8: u8 = guess[i] as u8;
        let s_u8: u8 = secret[i] as u8;
        assert(g_u8 as Field == guess[i]);
        assert(s_u8 as Field == secret[i]);
        assert(g_u8 < 10);
        assert(s_u8 < 10);
    }

    // Uniqueness simplifies partial match count logic.
    for i in 0..4 {
        for j in (i + 1)..4 {
            assert(guess[i] != guess[j]);
            assert(secret[i] != secret[j]);
        }
    }

    // Bind guess bytes to the packed u32-style value.
    let packed_guess =
        guess[0] * 16777216 + // 256^3
        guess[1] * 65536 +    // 256^2
        guess[2] * 256 +      // 256^1
        guess[3];             // 256^0
    assert(guess_packed == packed_guess);

    // Demo commitment binding: pack secret as a u32-like field.
    // This must match the public `commitment` input used for proving.
    let secret_commitment =
        secret[0] * 16777216 +
        secret[1] * 65536 +
        secret[2] * 256 +
        secret[3];
    assert(commitment == secret_commitment);

    // Exact matches: correct digit in correct slot.
    let mut ex = 0;
    for i in 0..4 {
        if secret[i] == guess[i] {
            ex += 1;
        }
    }

    // Total matches with unique-digit assumption, then derive partial.
    let mut total_matches = 0;
    for i in 0..4 {
        for j in 0..4 {
            if secret[i] == guess[j] {
                total_matches += 1;
            }
        }
    }
    let pa = total_matches - ex;

    assert(exact == ex);
    assert(partial == pa);
}
