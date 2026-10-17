use rusqlite::Connection;
use std::sync::{Arc, Mutex};

pub struct Database {
    pub url: String,
}

impl Database {
    /// Strip the `sqlite:` scheme that tauri-plugin-sql uses.
    /// rusqlite expects a raw filesystem path, not a URI.
    pub fn path(&self) -> &str {
        self.url.strip_prefix("sqlite:").unwrap_or(&self.url)
    }

    pub fn connection(&self) -> rusqlite::Result<Connection> {
        Connection::open(self.path())
    }
}

pub type DbState = Arc<Mutex<Database>>;
