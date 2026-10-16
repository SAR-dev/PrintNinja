use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DeepLinkAction {
    Print(DeepLinkPrint),
    Open(String),
    Template(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeepLinkPrint {
    pub preset: Option<String>,
    pub template: Option<String>,
    pub printer: Option<String>,
    pub url: Option<String>,
    pub copies: Option<u32>,
    pub orientation: Option<String>,
    pub fit: Option<String>,
    pub test: bool,
    pub confirm: bool,
    pub callback: Option<String>,
}

/// Parse a deep link URL into a structured action
pub fn parse_deep_link(url: &str) -> Result<DeepLinkAction, String> {
    let url = url.strip_prefix("printninja://").unwrap_or(url);

    let (path, query) = if let Some(idx) = url.find('?') {
        (&url[..idx], &url[idx + 1..])
    } else {
        (url, "")
    };

    let params = parse_query_params(query);

    match path {
        "print" => {
            let print = DeepLinkPrint {
                preset: params.get("preset").map(|s| s.to_string()),
                template: params.get("template").map(|s| s.to_string()),
                printer: params.get("printer").map(|s| s.to_string()),
                url: params.get("url").map(|s| s.to_string()),
                copies: params.get("copies").and_then(|s| s.parse().ok()),
                orientation: params.get("orientation").map(|s| s.to_string()),
                fit: params.get("fit").map(|s| s.to_string()),
                test: params.get("test").map(|s| s == "1" || s == "true").unwrap_or(false),
                confirm: params.get("confirm").map(|s| s != "0" && s != "false").unwrap_or(true),
                callback: params.get("callback").map(|s| s.to_string()),
            };
            Ok(DeepLinkAction::Print(print))
        }
        _ if path.starts_with("open/") => {
            let destination = path.strip_prefix("open/").unwrap_or("");
            Ok(DeepLinkAction::Open(destination.to_string()))
        }
        _ if path.starts_with("template/") => {
            let id = path.strip_prefix("template/").unwrap_or("");
            Ok(DeepLinkAction::Template(id.to_string()))
        }
        _ => Err(format!("Unknown deep link action: {}", path)),
    }
}

fn parse_query_params(query: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            params.insert(
                percent_decode(key),
                percent_decode(value),
            );
        }
    }
    params
}

fn percent_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(val) = u8::from_str_radix(
                &String::from_utf8_lossy(&bytes[i + 1..i + 3]),
                16,
            )
            .ok()
            {
                result.push(val as char);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i] as char);
        i += 1;
    }
    result
}
