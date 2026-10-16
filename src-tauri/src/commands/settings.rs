use crate::error::AppResult;

#[tauri::command]
pub fn get_setting(key: String) -> AppResult<Option<String>> {
    // TODO: Query from database
    Ok(None)
}

#[tauri::command]
pub fn set_setting(key: String, value: String) -> AppResult<()> {
    // TODO: Insert/update database
    Ok(())
}
