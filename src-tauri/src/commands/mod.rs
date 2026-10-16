pub mod printer;
pub mod template;
pub mod history;
pub mod settings;
pub mod print;
pub mod version;
pub mod font;
pub mod profile;
pub mod batch;
pub mod api;
pub mod deeplink_cmd;

#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}
