pub mod printer;
pub mod template;
pub mod history;
pub mod settings;
pub mod print;
pub mod version;
pub mod font;

#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}
