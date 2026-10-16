use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FontInfo {
    pub id: i64,
    pub family: String,
    pub style: String,
    pub weight: String,
    pub file_path: String,
    pub format: String,
    pub created_at: String,
}

#[tauri::command]
pub fn list_fonts() -> AppResult<Vec<FontInfo>> {
    // TODO: Query from database
    Ok(vec![])
}

#[tauri::command]
pub async fn upload_font(
    app: tauri::AppHandle,
    file_name: String,
    file_data: Vec<u8>,
) -> AppResult<FontInfo> {
    let fonts_dir = app.path().app_data_dir()?.join("fonts");
    std::fs::create_dir_all(&fonts_dir)?;

    let format = file_name.split('.').last().unwrap_or("ttf").to_string();
    let file_path = fonts_dir.join(&file_name);
    tokio::fs::write(&file_path, &file_data).await?;

    // TODO: Insert into database
    Ok(FontInfo {
        id: 0,
        family: file_name.trim_end_matches(".ttf").trim_end_matches(".otf").trim_end_matches(".woff2").to_string(),
        style: "normal".to_string(),
        weight: "400".to_string(),
        file_path: file_path.to_string_lossy().to_string(),
        format,
        created_at: String::new(),
    })
}

#[tauri::command]
pub fn delete_font(id: i64) -> AppResult<()> {
    // TODO: Delete from database and filesystem
    Ok(())
}
