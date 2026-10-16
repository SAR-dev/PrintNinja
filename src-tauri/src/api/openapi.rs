use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenApiSpec {
    pub openapi: String,
    pub info: ApiInfo,
    pub servers: Vec<ApiServer>,
    pub paths: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiInfo {
    pub title: String,
    pub version: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiServer {
    pub url: String,
    pub description: String,
}

impl Default for OpenApiSpec {
    fn default() -> Self {
        Self {
            openapi: "3.0.0".to_string(),
            info: ApiInfo {
                title: "PrintNinja API".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                description: "Local REST API for PrintNinja print automation".to_string(),
            },
            servers: vec![ApiServer {
                url: "http://127.0.0.1:17717".to_string(),
                description: "Local server".to_string(),
            }],
            paths: serde_json::json!({
                "/v1/health": {
                    "get": { "summary": "Health check" }
                },
                "/v1/printers": {
                    "get": { "summary": "List printers" }
                },
                "/v1/templates": {
                    "get": { "summary": "List templates" }
                },
                "/v1/print": {
                    "post": { "summary": "Create a print job" }
                },
                "/v1/print/batch": {
                    "post": { "summary": "Create a batch print" }
                },
                "/v1/jobs/{id}": {
                    "get": { "summary": "Get job status" },
                    "delete": { "summary": "Cancel job" }
                },
                "/v1/jobs/{id}/retry": {
                    "post": { "summary": "Retry failed job" }
                }
            }),
        }
    }
}
