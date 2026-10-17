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
                    "get": {
                        "summary": "Health check",
                        "description": "Unauthenticated liveness probe.",
                        "responses": {
                            "200": { "description": "Server is up" }
                        }
                    }
                },
                "/v1/printers": {
                    "get": {
                        "summary": "List printers",
                        "responses": {
                            "200": { "description": "Printers, with a `count`" },
                            "401": { "description": "Missing or invalid API key" }
                        }
                    }
                },
                "/v1/templates": {
                    "get": {
                        "summary": "List templates",
                        "responses": {
                            "200": { "description": "Templates, with a `count`" },
                            "401": { "description": "Missing or invalid API key" }
                        }
                    }
                },
                "/v1/print": {
                    "post": {
                        "summary": "Render a template and print it",
                        "description": "## Renders, then prints.\n\n`template` is required — the API has no inline HTML body, so there is\nnothing to render without one. The response reports the real outcome:\n\n* `200` — printed, with the job id and duration.\n* `400` — missing `template`.\n* `404` — printer or template not found, or the template has no current version.\n* `500` — the transport failed (printer offline, unsupported platform, …).\n\nSend `Idempotency-Key` on a retryable request. A replayed key returns\n`200` without printing a second copy.\n\nThis runs the same pipeline as the desktop UI and serialises on the\ntarget printer, so an API job and a UI job cannot interleave on one head.",
                        "parameters": [
                            { "name": "Authorization", "in": "header", "required": true,
                              "schema": { "type": "string" },
                              "description": "`Bearer <api-key>`" },
                            { "name": "Idempotency-Key", "in": "header", "required": false,
                              "schema": { "type": "string" },
                              "description": "Optional de-duplication key." }
                        ],
                        "requestBody": {
                            "required": true,
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "required": ["template", "printer", "data"],
                                        "properties": {
                                            "template": { "type": "string", "description": "Template name (case-insensitive)" },
                                            "printer": { "type": "string", "description": "Printer name (case-insensitive)" },
                                            "data": { "type": "object", "description": "Context merged into the template" },
                                            "data_url": { "type": "string", "description": "Fetch this URL and use the JSON as `data` instead" },
                                            "test": { "type": "boolean", "default": false },
                                            "settings": {
                                                "type": "object",
                                                "properties": {
                                                    "copies": { "type": "integer", "minimum": 1, "default": 1 },
                                                    "orientation": { "type": "string", "enum": ["portrait", "landscape"] },
                                                    "fit": { "type": "string", "enum": ["fit-width", "fit-page", "shrink", "fill"] }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        "responses": {
                            "200": { "description": "Printed: `{ job_id, status, duration_ms }`" },
                            "400": { "description": "`template` is required" },
                            "401": { "description": "Missing or invalid API key" },
                            "404": { "description": "Printer, template, or current version not found" },
                            "500": { "description": "The transport failed" }
                        }
                    }
                },
                "/v1/print/batch": {
                    "post": {
                        "summary": "Create a batch print",
                        "responses": {
                            "200": { "description": "Batch created" },
                            "401": { "description": "Missing or invalid API key" }
                        }
                    }
                },
                "/v1/jobs/{id}": {
                    "get": {
                        "summary": "Get job status",
                        "responses": {
                            "200": { "description": "Job record" },
                            "401": { "description": "Missing or invalid API key" }
                        }
                    },
                    "delete": {
                        "summary": "Cancel job",
                        "responses": {
                            "200": { "description": "Job cancelled" },
                            "401": { "description": "Missing or invalid API key" }
                        }
                    }
                },
                "/v1/jobs/{id}/retry": {
                    "post": {
                        "summary": "Retry failed job",
                        "responses": {
                            "200": { "description": "Job retried" },
                            "401": { "description": "Missing or invalid API key" }
                        }
                    }
                }
            }),
        }
    }
}
