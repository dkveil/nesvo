use anyhow::{Result, anyhow, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use crypto_secretbox::{
    Nonce, XSalsa20Poly1305,
    aead::{Aead, KeyInit},
};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod contract;
pub mod events;
pub mod views;

pub const MAX_FRAME: usize = 128 * 1024;
pub const MAX_PLAINTEXT: usize = 64 * 1024;

#[derive(Serialize, Deserialize)]
struct Frame {
    nonce: String,
    #[serde(rename = "box")]
    ciphertext: String,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    challenge: String,
    direction: String,
    seq: u64,
    payload: Value,
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

pub fn encode(payload: Value, key: &[u8; 32], challenge: &str, seq: u64) -> Result<String> {
    encode_direction(payload, key, challenge, seq, "host-to-client")
}

pub fn encode_client(payload: Value, key: &[u8; 32], challenge: &str, seq: u64) -> Result<String> {
    encode_direction(payload, key, challenge, seq, "client-to-host")
}

fn encode_direction(
    payload: Value,
    key: &[u8; 32],
    challenge: &str,
    seq: u64,
    direction: &str,
) -> Result<String> {
    let plaintext = serde_json::to_vec(&Envelope {
        challenge: challenge.into(),
        direction: direction.into(),
        seq,
        payload,
    })?;
    ensure!(plaintext.len() <= MAX_PLAINTEXT, "Message too large");
    let cipher = XSalsa20Poly1305::new(key.into());
    let nonce = random::<24>();
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_slice())
        .map_err(|_| anyhow!("Encryption failed"))?;
    Ok(serde_json::to_string(&Frame {
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })?)
}

pub fn decode(text: &str, key: &[u8; 32], challenge: &str, expected_seq: u64) -> Result<Value> {
    decode_direction(text, key, challenge, expected_seq, "client-to-host")
}

pub fn decode_host(
    text: &str,
    key: &[u8; 32],
    challenge: &str,
    expected_seq: u64,
) -> Result<Value> {
    decode_direction(text, key, challenge, expected_seq, "host-to-client")
}

fn decode_direction(
    text: &str,
    key: &[u8; 32],
    challenge: &str,
    expected_seq: u64,
    direction: &str,
) -> Result<Value> {
    ensure!(text.len() <= MAX_FRAME, "Frame too large");
    let frame: Frame = serde_json::from_str(text)?;
    let nonce = STANDARD.decode(frame.nonce)?;
    let ciphertext = STANDARD.decode(frame.ciphertext)?;
    ensure!(
        nonce.len() == 24 && ciphertext.len() <= MAX_PLAINTEXT + 16,
        "Invalid frame size"
    );
    let cipher = XSalsa20Poly1305::new(key.into());
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_slice())
        .map_err(|_| anyhow!("Authentication failed"))?;
    let envelope: Envelope = serde_json::from_slice(&plaintext)?;
    ensure!(
        envelope.challenge == challenge
            && envelope.direction == direction
            && envelope.seq == expected_seq
            && envelope.seq <= 9_007_199_254_740_991,
        "Invalid context or replayed frame"
    );
    Ok(envelope.payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn public_client_codec_interoperates_without_allowing_reflection() {
        let payload = json!({"type":"auth", "clientNonce":"nonce"});
        let client = encode_client(payload.clone(), &[9; 32], "fresh", 1).unwrap();
        assert_eq!(decode(&client, &[9; 32], "fresh", 1).unwrap(), payload);
        assert!(decode_host(&client, &[9; 32], "fresh", 1).is_err());
        let host = encode(json!({"type":"connected"}), &[9; 32], "fresh", 1).unwrap();
        assert_eq!(
            decode_host(&host, &[9; 32], "fresh", 1).unwrap()["type"],
            "connected"
        );
        assert!(decode_host(&host, &[9; 32], "stale", 1).is_err());
    }

    fn client_frame(key: &[u8; 32], challenge: &str, seq: u64) -> String {
        let data = serde_json::to_vec(&Envelope {
            challenge: challenge.into(),
            direction: "client-to-host".into(),
            seq,
            payload: json!({"type":"auth"}),
        })
        .unwrap();
        let nonce = [7; 24];
        let ciphertext = XSalsa20Poly1305::new(key.into())
            .encrypt(Nonce::from_slice(&nonce), data.as_slice())
            .unwrap();
        serde_json::to_string(&Frame {
            nonce: STANDARD.encode(nonce),
            ciphertext: STANDARD.encode(ciphertext),
        })
        .unwrap()
    }

    #[test]
    fn rejects_wrong_keys_connection_replay_and_sequence_replay() {
        let frame = client_frame(&[42; 32], "connection-a", 1);
        assert_eq!(
            decode(&frame, &[42; 32], "connection-a", 1).unwrap()["type"],
            "auth"
        );
        assert!(decode(&frame, &[43; 32], "connection-a", 1).is_err());
        assert!(decode(&frame, &[42; 32], "connection-b", 1).is_err());
        assert!(decode(&frame, &[42; 32], "connection-a", 2).is_err());
    }

    #[test]
    fn rejects_reflection_malformed_frames_and_oversized_frames() {
        let frame = encode(json!({"type":"connected"}), &[42; 32], "same", 1).unwrap();
        assert!(decode(&frame, &[42; 32], "same", 1).is_err());
        assert!(decode("{}", &[42; 32], "same", 1).is_err());
        assert!(decode(&"x".repeat(MAX_FRAME + 1), &[42; 32], "same", 1).is_err());
    }
}
