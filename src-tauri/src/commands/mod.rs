pub mod api;
pub mod background;
pub mod cache;
pub mod datasets;
pub mod deeplink_cmd;
pub mod font;
pub mod history;
pub mod logfile;
pub mod print;
pub mod printer;
pub mod profile;
pub mod remote_print;
pub mod render_engine;
pub mod reset;
pub mod settings;
pub mod template;

#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}
