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
                            "200": { "description": "Printers, with a `count`" },                        }
                    }
                },
                "/v1/templates": {
                    "get": {
                        "summary": "List templates",
                        "responses": {
                            "200": { "description": "Templates, with a `count`" },                        }
                    }
                },
                "/v1/metrics": {
                    "get": {
                        "summary": "Operational counters",
                        "description": "Jobs by status, active batches, queue-tracked printers, completed totals since boot, shared-render attempts (bought vs locally fallen back), and browser renders (persistent vs one-shot fallback). Same shape every call; poll it.",
                        "responses": {
                            "200": { "description": "Counters" },                        }
                    }
                },
                "/v1/metrics/prometheus": {
                    "get": {
                        "summary": "Prometheus exposition",
                        "description": "Same counters as /v1/metrics in text format 0.0.4.",
                        "responses": {
                            "200": { "description": "Metrics in Prometheus text format" },                        }
                    }
                },
                "/v1/print": {
                    "post": {
                        "summary": "Render a template and print it",
                        "description": "## Renders, then prints.\n\n`template` is required — the API has no inline HTML body, so there is\nnothing to render without one. `data` is optional. The response reports\nthe real outcome:\n\n* `200` — printed, with the job id and duration.\n* `400` — missing `template`, or a `callback_url` was sent (callbacks are not implemented; poll `GET /v1/jobs/{id}` for the outcome).\n* `404` — printer or template not found, or the template has no current version.\n* `500` — the transport failed (printer offline, unsupported platform, …).\n\nSend `Idempotency-Key` on a retryable request. A replayed key returns\n`200` without printing a second copy.\n\nThis runs the same pipeline as the desktop UI and serialises on the\ntarget printer, so an API job and a UI job cannot interleave on one head.",
                        "parameters": [
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
                                        "required": ["template", "printer"],
                                        "properties": {
                                            "template": { "type": "string", "description": "Template name (case-insensitive)" },
                                            "printer": { "type": "string", "description": "Printer name (case-insensitive)" },
                                            "data": { "type": "object", "description": "Context merged into the template; optional — an empty context prints, like the preview" },
                                            "data_url": { "type": "string", "description": "Fetch this URL and use the JSON as `data` instead; `http`/`https` only, public addresses only" },
                                            "test": { "type": "boolean", "default": false },
                                            "settings": {
                                                "type": "object",
                                                "properties": {
                                                    "copies": { "type": "integer", "minimum": 1, "default": 1 },
                                                    "orientation": { "type": "string", "enum": ["portrait", "landscape"] },
                                                    "page_range": { "type": "string", "description": "1-based pages, e.g. \"1-3\" or \"1,3,5-7\"; empty means all" },
                                                    "grayscale": { "type": "boolean", "default": false },
                                                    "fit": { "type": "string", "enum": ["fit-width", "fit-page", "shrink", "fill"] }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        "responses": {
                            "200": { "description": "Printed: `{ job_id, status, duration_ms }`; also the `duplicate` body for a replayed `Idempotency-Key`" },
                            "400": { "description": "`template` is required, or `callback_url` was sent (not supported)" },                            "404": { "description": "Printer, template, or current version not found" },
                            "415": { "description": "Wrong or missing `Content-Type`" },
                            "422": { "description": "Malformed JSON, or `printer` missing" },
                            "500": { "description": "The transport failed" }
                        }
                    }
                },
                "/v1/jobs": {
                    "get": {
                        "summary": "List jobs",
                        "responses": {
                            "200": { "description": "Jobs, with a `count`" },                        }
                    }
                },
                "/v1/jobs/{id}": {
                    "get": {
                        "summary": "Get job status",
                        "responses": {
                            "200": { "description": "Job record" },
                            "400": { "description": "`id` is not an integer" },                            "404": { "description": "No such job" }
                        }
                    },
                    "delete": {
                        "summary": "Cancel a queued job",
                        "description": "Only a `queued` job can be cancelled; the row ends `cancelled`.",
                        "responses": {
                            "204": { "description": "Cancelled (no body)" },
                            "400": { "description": "`id` is not an integer, or the job is missing or not cancellable (already started or finished)" },                        }
                    }
                },
                "/v1/jobs/{id}/retry": {
                    "post": {
                        "summary": "Re-queue a failed or cancelled job",
                        "description": "Only a terminal row (`failed`, `cancelled`) is re-queued — a running or queued row is refused, so the worker can never print twice. The worker prints the re-queued row.",
                        "responses": {
                            "200": { "description": "Re-queued: `{ job_id, status }`" },
                            "400": { "description": "`id` is not an integer, or the job is not failed/cancelled" },                            "404": { "description": "No such job" }
                        }
                    }
                },
                "/v1/openapi.json": {
                    "get": {
                        "summary": "This document",
                        "responses": {
                            "200": { "description": "The OpenAPI description of this API" },                        }
                    }
                },
                "/v1/render": {
                    "post": {
                        "summary": "Render finished HTML to printer bytes (shared rendering)",
                        "description": "Provider endpoint for a paired device: runs the same render stage as the local pipeline over caller-supplied HTML and geometry, and returns the bytes the printer head takes. Requires `Authorization: Bearer <per-device token>` minted by POST /v1/pair/claim; 403 when sharing is disabled, 401 on a bad token. PDF `language` returns document bytes; any other language returns a raster at `dpi` encoded for that dialect. No template, data, or printer is touched — the caller resolves everything first.",
                        "parameters": [
                            { "name": "Authorization", "in": "header", "required": true,
                              "schema": { "type": "string" },
                              "description": "Bearer per-device token from pairing with this device." }
                        ],
                        "requestBody": {
                            "required": true,
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "required": ["protocol", "html", "paper_w_mm", "paper_h_mm", "orientation", "language", "dpi"],
                                        "properties": {
                                            "protocol": { "type": "integer", "description": "Must be 1" },
                                            "html": { "type": "string", "description": "Finished, laid-out document (10MB cap)" },
                                            "paper_w_mm": { "type": "number" },
                                            "paper_h_mm": { "type": "number" },
                                            "orientation": { "type": "string", "enum": ["portrait", "landscape"] },
                                            "language": { "type": "string", "enum": ["pdf", "escpos", "tspl", "zpl", "cpcl", "raster"] },
                                            "dpi": { "type": "integer", "minimum": 1, "maximum": 1200 }
                                        }
                                    }
                                }
                            }
                        },
                        "responses": {
                            "200": { "description": "Rendered: `{ bytes_b64, mime, render_ms }`" },
                            "400": { "description": "Bad protocol, geometry, orientation, or unknown language" },
                            "401": { "description": "Bad or missing pairing token" },
                            "403": { "description": "Render sharing is disabled on this device" },
                            "413": { "description": "HTML over the 10MB cap, or the whole request over the 16MB body cap" },
                            "422": { "description": "The render itself failed (or this device has no renderer)" },
                            "429": { "description": "Provider is at its render limit or printing its own job (honour `Retry-After`, or render locally)" },
                            "500": { "description": "The provider's cache dir is unavailable" }
                        }
                    }
                },
                "/v1/capabilities": {
                    "get": {
                        "summary": "Provider capability advertisement",
                        "description": "Same per-device-token gate as /v1/render. Reports the protocol version, whether this device can render, and a static capability score (cores plus a browser-renderer bonus) the consumer uses to pick the fastest reachable provider.",
                        "parameters": [
                            { "name": "Authorization", "in": "header", "required": true,
                              "schema": { "type": "string" },
                              "description": "Bearer per-device token from pairing with this device." }
                        ],
                        "responses": {
                            "200": { "description": "`{ protocol, can_render, score, cores, platform, max_concurrent_renders }`" },
                            "401": { "description": "Bad or missing pairing token" },
                            "403": { "description": "Render sharing is disabled on this device" }
                        }
                    }
                },
                "/v1/pair/hello": {
                    "get": {
                        "summary": "Pairing discovery hello",
                        "description": "While a pairing window is open (PC tapped Pair a phone), answers who this PC is so a phone that typed the code can find it. No auth; only answers while a window is open, otherwise 403 like claim.",
                        "responses": {
                            "200": { "description": "`{ protocol, provider_id, name, platform, port }`" },
                            "403": { "description": "Pairing is not available (sharing disabled or no window open)" },
                            "410": { "description": "The pairing code expired" },
                            "429": { "description": "Too many wrong codes; the window is closed" }
                        }
                    }
                },
                "/v1/pair/claim": {
                    "post": {
                        "summary": "Claim a pairing code for a per-device token",
                        "description": "Presents the 8-character code plus this device's id, name and platform. On success mints a per-device token (shown once; the PC stores only its SHA-256) and closes the window. Single use; 5 wrong guesses close the window.",
                        "requestBody": {
                            "required": true,
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "required": ["protocol", "code", "device_id"],
                                        "properties": {
                                            "protocol": { "type": "integer", "description": "Must be 1" },
                                            "code": { "type": "string", "description": "8 characters from ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (dashes and spaces optional)" },
                                            "device_id": { "type": "string", "description": "This phone's stable id (UUID); re-pairing replaces its row" },
                                            "device_name": { "type": "string", "description": "This phone's name" },
                                            "platform": { "type": "string", "description": "This phone's platform" }
                                        }
                                    }
                                }
                            }
                        },
                        "responses": {
                            "200": { "description": "Paired: `{ provider_id, provider_name, provider_platform, port, token, paired_at }`" },
                            "400": { "description": "Malformed code or body, or unsupported protocol" },
                            "401": { "description": "Wrong code (body includes `attempts_left`)" },
                            "403": { "description": "Pairing is not available (sharing disabled or no window open)" },
                            "410": { "description": "The pairing code expired" },
                            "429": { "description": "Wrong-guess cap hit; the window is closed" }
                        }
                    }
                }
            }),
        }
    }
}
