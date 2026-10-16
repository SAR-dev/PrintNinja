use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// API key structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKey {
    pub id: i64,
    pub name: String,
    pub key_hash: String,
    pub scopes: Vec<String>,
    pub allowed_ips: Vec<String>,
}

impl ApiKey {
    pub fn generate() -> (String, String) {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let key: String = (0..32).map(|_| rng.sample(rand::distributions::Alphanumeric) as char).collect();
        let prefixed = format!("pn_live_{}", key);
        let hash = hash_key(&prefixed);
        (prefixed, hash)
    }

    pub fn check_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope || s == "admin")
    }
}

pub fn hash_key(key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    let result = hasher.finalize();
    hex::encode(result)
}

pub fn verify_key(key: &str, hash: &str) -> bool {
    let computed = hash_key(key);
    computed == hash
}

/// Rate limiter (simple token bucket)
pub struct RateLimiter {
    max_tokens: u32,
    tokens: u32,
    last_refill: std::time::Instant,
    refill_rate: u32, // tokens per second
}

impl RateLimiter {
    pub fn new(max_tokens: u32, refill_rate: u32) -> Self {
        Self {
            max_tokens,
            tokens: max_tokens,
            last_refill: std::time::Instant::now(),
            refill_rate,
        }
    }

    pub fn check(&mut self) -> bool {
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs() as u32;
        self.tokens = (self.tokens + elapsed * self.refill_rate).min(self.max_tokens);
        self.last_refill = now;

        if self.tokens > 0 {
            self.tokens -= 1;
            true
        } else {
            false
        }
    }
}