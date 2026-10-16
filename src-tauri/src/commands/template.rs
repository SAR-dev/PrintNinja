use crate::error::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    pub id: i64,
    pub name: String,
    pub current_version_id: Option<i64>,
    pub page_w_mm: i64,
    pub page_h_mm: i64,
    pub orientation: String,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
pub fn list_templates() -> AppResult<Vec<Template>> {
    // TODO: Query from database
    Ok(vec![])
}

#[derive(Debug, Deserialize)]
pub struct CreateTemplateRequest {
    pub name: String,
    pub page_w_mm: Option<i64>,
    pub page_h_mm: Option<i64>,
    pub orientation: Option<String>,
}

#[tauri::command]
pub fn create_template(req: CreateTemplateRequest) -> AppResult<Template> {
    // TODO: Insert into database
    Ok(Template {
        id: 0,
        name: req.name,
        current_version_id: None,
        page_w_mm: req.page_w_mm.unwrap_or(210),
        page_h_mm: req.page_h_mm.unwrap_or(297),
        orientation: req.orientation.unwrap_or_else(|| "portrait".to_string()),
        created_at: String::new(),
        updated_at: String::new(),
    })
}

#[tauri::command]
pub fn delete_template(id: i64) -> AppResult<()> {
    // TODO: Delete from database
    Ok(())
}
