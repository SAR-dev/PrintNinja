use anyhow::Result;
use serde::Deserialize;
use std::time::Duration;

#[derive(Debug, Deserialize)]
pub struct FetchOptions {
    pub url: String,
    pub method: String,
    pub headers: Option<Vec<(String, String)>>,
    pub timeout_secs: u64,
    pub max_size_bytes: u64,
    pub json_path: Option<String>,
}

pub struct DataFetcher;

impl DataFetcher {
    pub fn new() -> Self {
        Self
    }

    pub async fn fetch(&self, options: &FetchOptions) -> Result<serde_json::Value> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(options.timeout_secs))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()?;

        let mut request = client.request(
            reqwest::Method::from_bytes(options.method.as_bytes())?,
            &options.url,
        );

        if let Some(headers) = &options.headers {
            for (key, value) in headers {
                request = request.header(key, value);
            }
        }

        let response = request.send().await?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP {} from {}",
                response.status(),
                options.url
            ));
        }

        let content_length = response.content_length().unwrap_or(0);
        if content_length > options.max_size_bytes {
            return Err(anyhow::anyhow!(
                "Response too large: {} bytes (max {})",
                content_length,
                options.max_size_bytes
            ));
        }

        let text = response.text().await?;
        let data: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| anyhow::anyhow!("Invalid JSON from {}: {}", options.url, e))?;

        // Apply JSON path if specified
        if let Some(path) = &options.json_path {
            return Ok(extract_json_path(&data, path));
        }

        Ok(data)
    }
}

fn extract_json_path(data: &serde_json::Value, path: &str) -> serde_json::Value {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = data;

    for part in parts {
        if let Some(index) = part.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            if let Ok(i) = index.parse::<usize>() {
                current = &current[i];
            }
        } else {
            current = &current[part];
        }
    }

    current.clone()
}
