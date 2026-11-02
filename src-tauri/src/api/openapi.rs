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
                "/v1/pc-templates": {
                    "get": {
                        "summary": "Printable templates for a paired phone",
                        "description": "Synced rows only (name, `server_id`, `server_revision`) — never bodies. A phone printing via this PC lists these instead of its own rows, so the version check matches by construction.",
                        "responses": {
                            "200": { "description": "Printable templates, with a `count`" },                        }
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
                        "description": "## Renders, then prints.\n\n`template` is required — the API has no inline HTML body, so there is\nnothing to render without one. `data` is optional. The response reports\nthe real outcome:\n\n* `200` — printed, with the job id and duration. When `callback_url` is supplied and valid, the job still returns synchronously and a best-effort callback is POSTed after the job reaches `success` or `failed` (not on `duplicate`).\n* `400` — missing `template`, an invalid `callback_url` (`code: callback_url_invalid` — not https, targets private/loopback/link-local, too long >2048, contains credentials, or not in `PRINTNINJA_CALLBACK_ALLOWLIST`), `settings.copies` is over the max, or `data` is over the size limit.\n* `404` — printer or template not found, or the template has no current version.\n* `409` — `template_server_id` named a template the PC lacks (`template_missing`) or a revision that differs from the PC's copy (`template_stale`, with both revisions); sync templates, then retry.\n* `500` — the transport failed (printer offline, unsupported platform, …).\n\nSend `Idempotency-Key` on a retryable request. A replayed key returns\n`200` without printing a second copy and does **not** fire a second callback.\n\n`callback_url` (optional) — `https://` URL to POST the outcome to. `https` only by default; `http` allowed only with `PRINTNINJA_CALLBACK_ALLOW_HTTP=1`. Private/loopback/link-local hosts are blocked unless `PRINTNINJA_CALLBACK_ALLOW_PRIVATE=1`. When `PRINTNINJA_CALLBACK_ALLOWLIST` is set, only those hosts are allowed. Length ≤2048, no `user:pass@`. After the job reaches a terminal state (`success` or `failed`), the server fire-and-forgets a `POST callback_url` with `Content-Type: application/json`, body `{ event: \"print.succeeded\"|\"print.failed\", job_id, status: \"success\"|\"failed\", printer, template, error, duration_ms, timestamp, idempotency_key }`, headers `X-PrintNinja-Event`, `X-PrintNinja-Job-Id`, `User-Agent: PrintNinja/2.5`, and optionally `X-PrintNinja-Signature: sha256=<hex(hmac_sha256(PRINTNINJA_CALLBACK_SECRET, body))>` when `PRINTNINJA_CALLBACK_SECRET` is set. Retries: up to 3 retries (4 attempts) with exponential backoff 5s/25s/125s, 10s timeout per attempt, 64 KiB response cap, no redirect follow, warn logs with host only (never full URL).\n\nOver LAN the caller's paired-device id is stamped on the job row as\n`requested_by_device_id`, so history shows which phone asked; loopback\ncalls leave it empty.\n\nThis runs the same pipeline as the desktop UI and serialises on the\ntarget printer, so an API job and a UI job cannot interleave on one head.",
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
                                            "template_server_id": { "type": "string", "description": "Synced template identity: resolved by this, never by name, and the revision must match the PC's copy (409 otherwise)" },
                                            "template_server_revision": { "type": "integer", "description": "Revision the caller holds; required with `template_server_id`" },
                                            "printer": { "type": "string", "description": "Printer name (case-insensitive)" },
                                            "data": { "type": "object", "description": "Context merged into the template; optional — an empty context prints, like the preview. Over ~1 MiB is refused; use `data_url` for big payloads" },
                                            "data_url": { "type": "string", "description": "Fetch this URL and use the JSON as `data` instead; `http`/`https` only, public addresses only" },
                                            "test": { "type": "boolean", "default": false },
                                            "settings": {
                                                "type": "object",
                                                "properties": {
                                                    "copies": { "type": "integer", "minimum": 1, "maximum": 100, "default": 1 },
                                                    "orientation": { "type": "string", "enum": ["portrait", "landscape"] },
                                                    "page_range": { "type": "string", "description": "1-based pages, e.g. \"1-3\" or \"1,3,5-7\"; empty means all" },
                                                    "grayscale": { "type": "boolean", "default": false },
                                                    "fit": { "type": "string", "enum": ["fit-width", "fit-page", "shrink", "fill"] }
                                                }
                                            },
                                            "callback_url": { "type": "string", "format": "uri", "description": "HTTPS URL to POST job outcome to (best-effort, 3 retries 5s/25s/125s, 10s timeout, 64 KiB response cap, no redirect, HMAC sha256=<hex> when PRINTNINJA_CALLBACK_SECRET set). https only by default (http with PRINTNINJA_CALLBACK_ALLOW_HTTP=1), private hosts blocked unless PRINTNINJA_CALLBACK_ALLOW_PRIVATE=1, allowlist via PRINTNINJA_CALLBACK_ALLOWLIST, max 2048 chars, no credentials" }
                                        }
                                    }
                                }
                            }
                        },
                        "responses": {
                            "200": { "description": "Printed: `{ job_id, status, duration_ms }`; also the `duplicate` body for a replayed `Idempotency-Key` (no second callback)" },
                            "400": { "description": "`template` is required, an invalid `callback_url` (`code: callback_url_invalid` with reason), or a remote-job limit bit (`copies`, `data` size). Valid `callback_url` produces a job plus a best-effort callback (headers `X-PrintNinja-Event`, `X-PrintNinja-Job-Id`, `X-PrintNinja-Signature` when secret set)" },                            "404": { "description": "Printer, template, or current version not found" },
                            "409": { "description": "`template_missing` or `template_stale`, with a `code` plus the revisions; sync and retry" },
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
                        "description": "The record carries `requested_by_device_id`: the paired phone that asked for the print, or null for a local print.",
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
                        "description": "While sharing is on, answers who this PC is so a phone can find it — window open or not, since a guest invite is claimed with no window. `window_open` tells the phone whether an owner code is showing. No auth; the code does that at claim time.",
                        "responses": {
                            "200": { "description": "`{ protocol, provider_id, name, platform, port, window_open }`" },
                            "403": { "description": "Pairing is not available (sharing disabled or off-LAN caller)" }
                        }
                    }
                },
                "/v1/pair/claim": {
                    "post": {
                        "summary": "Claim a pairing code for a per-device token",
                        "description": "Presents the 8-character code plus this device's id, name and platform. An owner code needs an open window; a guest invite code redeems with no window, no account. On success mints a per-device token (shown once; the PC stores only its SHA-256) and closes the window. Single use; 5 wrong guesses close the window. Same-account pairing: the phone also sends the `account_id` it is signed in to plus its `service_url`, and the PC refuses a mismatch — both devices must be signed in to the same account on the same server.",
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
                                            "platform": { "type": "string", "description": "This phone's platform" },
                                            "account_id": { "type": "string", "description": "Account this phone is signed in to (server user id); must match the PC's" },
                                            "service_url": { "type": "string", "description": "Service URL the account belongs to; must match the PC's" }
                                        }
                                    }
                                }
                            }
                        },
                        "responses": {
                            "200": { "description": "Paired: `{ provider_id, provider_name, provider_platform, port, token, paired_at }`" },
                            "400": { "description": "Malformed code or body, unsupported protocol, or the phone sent no account (sign in first)" },
                            "401": { "description": "Wrong code (body includes `attempts_left`)" },
                            "403": { "description": "Pairing is not available (sharing disabled or no window open), the PC is signed out, or the accounts differ (body `code` tells which)" },
                            "410": { "description": "The pairing code expired" },
                            "429": { "description": "Wrong-guess cap hit; the window is closed" }
                        }
                    }
                }
            }),
        }
    }
}
