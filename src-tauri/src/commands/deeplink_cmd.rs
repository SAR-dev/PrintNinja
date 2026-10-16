use crate::error::AppResult;
use crate::deeplink::{parse_deep_link, DeepLinkAction};

#[tauri::command]
pub fn parse_deeplink(url: String) -> AppResult<DeepLinkAction> {
    parse_deep_link(&url).map_err(|e| crate::error::AppError::Validation(e))
}
