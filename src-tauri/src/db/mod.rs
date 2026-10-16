use rusqlite::Connection;
use std::sync::{Arc, Mutex};

pub struct Database {
    pub url: String,
}

impl Database {
    pub fn connection(&self) -> rusqlite::Result<Connection> {
        Connection::open(&self.url)
    }
}

pub type DbState = Arc<Mutex<Database>>;
