use axum::Router;
use std::net::TcpListener as SyncTcpListener;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};

pub struct ApiServer {
    port: u16,
    bind_address: String,
    running: bool,
}

impl ApiServer {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            bind_address: "127.0.0.1".to_string(),
            running: false,
        }
    }

    pub fn set_lan_access(&mut self, enabled: bool) {
        if enabled {
            self.bind_address = "0.0.0.0".to_string();
        } else {
            self.bind_address = "127.0.0.1".to_string();
        }
    }

    pub async fn start(&mut self) -> Result<(), String> {
        let addr = format!("{}:{}", self.bind_address, self.port);

        // Check if port is available
        let sync_listener = SyncTcpListener::bind(&addr)
            .map_err(|e| format!("Failed to bind to {}: {}", addr, e))?;
        sync_listener
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to set non-blocking: {}", e))?;

        let listener = TcpListener::from_std(sync_listener)
            .map_err(|e| format!("Failed to create async listener: {}", e))?;

        self.running = true;
        println!("API server starting on {}", addr);

        // Build router with CORS
        let cors = CorsLayer::new()
            .allow_origin(Any)
            .allow_headers(Any)
            .allow_methods(Any);

        let app = routes::build_router().layer(cors);

        // Spawn server
        let server = axum::serve(listener, app);
        let _ = server.await;

        Ok(())
    }

    pub fn stop(&mut self) {
        self.running = false;
    }

    pub fn is_running(&self) -> bool {
        self.running
    }

    pub fn bind_address(&self) -> &str {
        &self.bind_address
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

use super::routes;
