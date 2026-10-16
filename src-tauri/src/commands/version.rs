use crate::error::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateVersion {
    pub id: i64,
    pub template_id: i64,
    pub version_no: i64,
    pub html: String,
    pub css: String,
    pub label: Option<String>,
    pub note: Option<String>,
    pub created_at: String,
    pub created_by: String,
}

#[tauri::command]
pub fn list_versions(template_id: i64) -> AppResult<Vec<TemplateVersion>> {
    // TODO: Query from database
    Ok(vec![])
}

#[derive(Debug, Deserialize)]
pub struct CreateVersionRequest {
    pub template_id: i64,
    pub html: String,
    pub css: String,
    pub label: Option<String>,
    pub note: Option<String>,
    pub created_by: Option<String>,
}

#[tauri::command]
pub fn create_version(req: CreateVersionRequest) -> AppResult<TemplateVersion> {
    // TODO: Insert into database
    Ok(TemplateVersion {
        id: 0,
        template_id: req.template_id,
        version_no: 1,
        html: req.html,
        css: req.css,
        label: req.label,
        note: req.note,
        created_at: String::new(),
        created_by: req.created_by.unwrap_or_else(|| "manual".to_string()),
    })
}

#[tauri::command]
pub fn delete_version(id: i64) -> AppResult<()> {
    // TODO: Delete from database
    Ok(())
}
