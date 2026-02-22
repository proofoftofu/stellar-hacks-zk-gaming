import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}





export interface Game {
  attempts_used: u32;
  commitment: Option<Buffer>;
  ended: boolean;
  feedbacks: Array<FeedbackRecord>;
  guesses: Array<GuessRecord>;
  max_attempts: u32;
  next_guess_id: u32;
  pending_guess_id: Option<u32>;
  player1: string;
  player1_points: i128;
  player2: string;
  player2_points: i128;
  solved: boolean;
  winner: Option<string>;
}

export const Errors = {
  1: {message:"GameNotFound"},
  2: {message:"NotPlayer"},
  3: {message:"GameAlreadyEnded"},
  4: {message:"CommitmentAlreadySet"},
  5: {message:"CommitmentNotSet"},
  6: {message:"GuessPendingFeedback"},
  7: {message:"NoPendingGuess"},
  8: {message:"InvalidGuessId"},
  9: {message:"InvalidFeedback"},
  10: {message:"InvalidPublicInputs"},
  11: {message:"InvalidProof"},
  12: {message:"AttemptsExhausted"},
  13: {message:"VerifierNotSet"},
  14: {message:"InvalidProofBlob"},
  15: {message:"InvalidGuess"}
}

export type DataKey = {tag: "Game", values: readonly [u32]} | {tag: "GameHubAddress", values: void} | {tag: "Admin", values: void} | {tag: "VerifierAddress", values: void};


export interface GuessRecord {
  guess: Buffer;
  guess_id: u32;
}

export const VerifierError = {
  1: {message:"VkParseError"},
  2: {message:"ProofParseError"},
  3: {message:"VerificationFailed"},
  4: {message:"VkNotSet"}
}


export interface FeedbackRecord {
  exact: u32;
  guess_id: u32;
  partial: u32;
  proof_hash: Buffer;
}

export interface Client {
  /**
   * Construct and simulate a get_hub transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_hub: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a set_hub transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_hub: ({new_hub}: {new_hub: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_game: ({session_id}: {session_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Game>>>

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a start_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  start_game: ({session_id, player1, player2, player1_points, player2_points}: {session_id: u32, player1: string, player2: string, player1_points: i128, player2_points: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a commit_code transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  commit_code: ({session_id, commitment}: {session_id: u32, commitment: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_verifier: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a set_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_verifier: ({verifier}: {verifier: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a submit_guess transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  submit_guess: ({session_id, guess}: {session_id: u32, guess: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a submit_feedback_proof transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  submit_feedback_proof: ({session_id, guess_id, exact, partial, proof_blob}: {session_id: u32, guess_id: u32, exact: u32, partial: u32, proof_blob: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, game_hub}: {admin: string, game_hub: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, game_hub}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAQAAAAAAAAAAAAAABEdhbWUAAAAOAAAAAAAAAA1hdHRlbXB0c191c2VkAAAAAAAABAAAAAAAAAAKY29tbWl0bWVudAAAAAAD6AAAA+4AAAAgAAAAAAAAAAVlbmRlZAAAAAAAAAEAAAAAAAAACWZlZWRiYWNrcwAAAAAAA+oAAAfQAAAADkZlZWRiYWNrUmVjb3JkAAAAAAAAAAAAB2d1ZXNzZXMAAAAD6gAAB9AAAAALR3Vlc3NSZWNvcmQAAAAAAAAAAAxtYXhfYXR0ZW1wdHMAAAAEAAAAAAAAAA1uZXh0X2d1ZXNzX2lkAAAAAAAABAAAAAAAAAAQcGVuZGluZ19ndWVzc19pZAAAA+gAAAAEAAAAAAAAAAdwbGF5ZXIxAAAAABMAAAAAAAAADnBsYXllcjFfcG9pbnRzAAAAAAALAAAAAAAAAAdwbGF5ZXIyAAAAABMAAAAAAAAADnBsYXllcjJfcG9pbnRzAAAAAAALAAAAAAAAAAZzb2x2ZWQAAAAAAAEAAAAAAAAABndpbm5lcgAAAAAD6AAAABM=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAADwAAAAAAAAAMR2FtZU5vdEZvdW5kAAAAAQAAAAAAAAAJTm90UGxheWVyAAAAAAAAAgAAAAAAAAAQR2FtZUFscmVhZHlFbmRlZAAAAAMAAAAAAAAAFENvbW1pdG1lbnRBbHJlYWR5U2V0AAAABAAAAAAAAAAQQ29tbWl0bWVudE5vdFNldAAAAAUAAAAAAAAAFEd1ZXNzUGVuZGluZ0ZlZWRiYWNrAAAABgAAAAAAAAAOTm9QZW5kaW5nR3Vlc3MAAAAAAAcAAAAAAAAADkludmFsaWRHdWVzc0lkAAAAAAAIAAAAAAAAAA9JbnZhbGlkRmVlZGJhY2sAAAAACQAAAAAAAAATSW52YWxpZFB1YmxpY0lucHV0cwAAAAAKAAAAAAAAAAxJbnZhbGlkUHJvb2YAAAALAAAAAAAAABFBdHRlbXB0c0V4aGF1c3RlZAAAAAAAAAwAAAAAAAAADlZlcmlmaWVyTm90U2V0AAAAAAANAAAAAAAAABBJbnZhbGlkUHJvb2ZCbG9iAAAADgAAAAAAAAAMSW52YWxpZEd1ZXNzAAAADw==",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABAAAAAEAAAAAAAAABEdhbWUAAAABAAAABAAAAAAAAAAAAAAADkdhbWVIdWJBZGRyZXNzAAAAAAAAAAAAAAAAAAVBZG1pbgAAAAAAAAAAAAAAAAAAD1ZlcmlmaWVyQWRkcmVzcwA=",
        "AAAAAQAAAAAAAAAAAAAAC0d1ZXNzUmVjb3JkAAAAAAIAAAAAAAAABWd1ZXNzAAAAAAAD7gAAAAQAAAAAAAAACGd1ZXNzX2lkAAAABA==",
        "AAAABAAAAAAAAAAAAAAADVZlcmlmaWVyRXJyb3IAAAAAAAAEAAAAAAAAAAxWa1BhcnNlRXJyb3IAAAABAAAAAAAAAA9Qcm9vZlBhcnNlRXJyb3IAAAAAAgAAAAAAAAASVmVyaWZpY2F0aW9uRmFpbGVkAAAAAAADAAAAAAAAAAhWa05vdFNldAAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAADkZlZWRiYWNrUmVjb3JkAAAAAAAEAAAAAAAAAAVleGFjdAAAAAAAAAQAAAAAAAAACGd1ZXNzX2lkAAAABAAAAAAAAAAHcGFydGlhbAAAAAAEAAAAAAAAAApwcm9vZl9oYXNoAAAAAAPuAAAAIA==",
        "AAAAAAAAAAAAAAAHZ2V0X2h1YgAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAAAAAAAHc2V0X2h1YgAAAAABAAAAAAAAAAduZXdfaHViAAAAABMAAAAA",
        "AAAAAAAAAAAAAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAAAAAAAAIZ2V0X2dhbWUAAAABAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAQAAA+kAAAfQAAAABEdhbWUAAAAD",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAAAAAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAAAAAAAKc3RhcnRfZ2FtZQAAAAAABQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAHcGxheWVyMQAAAAATAAAAAAAAAAdwbGF5ZXIyAAAAABMAAAAAAAAADnBsYXllcjFfcG9pbnRzAAAAAAALAAAAAAAAAA5wbGF5ZXIyX3BvaW50cwAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAALY29tbWl0X2NvZGUAAAAAAgAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAKY29tbWl0bWVudAAAAAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAMZ2V0X3ZlcmlmaWVyAAAAAAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAAAAAAAAMc2V0X3ZlcmlmaWVyAAAAAQAAAAAAAAAIdmVyaWZpZXIAAAATAAAAAA==",
        "AAAAAAAAAAAAAAAMc3VibWl0X2d1ZXNzAAAAAgAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAFZ3Vlc3MAAAAAAAPuAAAABAAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIZ2FtZV9odWIAAAATAAAAAA==",
        "AAAAAAAAAAAAAAAVc3VibWl0X2ZlZWRiYWNrX3Byb29mAAAAAAAABQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAIZ3Vlc3NfaWQAAAAEAAAAAAAAAAVleGFjdAAAAAAAAAQAAAAAAAAAB3BhcnRpYWwAAAAABAAAAAAAAAAKcHJvb2ZfYmxvYgAAAAAADgAAAAEAAAPpAAAAAgAAAAM=" ]),
      options
    )
  }
  public readonly fromJSON = {
    get_hub: this.txFromJSON<string>,
        set_hub: this.txFromJSON<null>,
        upgrade: this.txFromJSON<null>,
        get_game: this.txFromJSON<Result<Game>>,
        get_admin: this.txFromJSON<string>,
        set_admin: this.txFromJSON<null>,
        start_game: this.txFromJSON<Result<void>>,
        commit_code: this.txFromJSON<Result<void>>,
        get_verifier: this.txFromJSON<Option<string>>,
        set_verifier: this.txFromJSON<null>,
        submit_guess: this.txFromJSON<Result<u32>>,
        submit_feedback_proof: this.txFromJSON<Result<void>>
  }
}