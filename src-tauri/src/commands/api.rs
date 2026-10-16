use crate::error::AppResult;

#[tauri::command]
pub fn start_api_server(port: Option<u16>, lan_access: Option<bool>) -> AppResult<String> {
    let port = port.unwrap_or(17717);
    // TODO: Store server handle, start in background
    Ok(format!("API server started on port {}", port))
}

#[tauri::command]
pub fn stop_api_server() -> AppResult<()> {
    // TODO: Stop running server
    Ok(())
}

#[tauri::command]
pub fn get_api_status() -> AppResult<String> {
    Ok("disabled".to_string())
}

#[tauri::command]
pub fn regenerate_api_key() -> AppResult<String> {
    use crate::api::auth::ApiKey;
    let (key, hash) = ApiKey::generate();
    // TODO: Store hash in database
    Ok(key)
}
