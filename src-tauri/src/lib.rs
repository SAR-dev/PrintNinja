mod api;
mod commands;
pub mod db;
mod deeplink;
pub mod render;
mod transport;
mod queue;
mod data;
mod error;

use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_sql::Migration;
use tauri_plugin_sql::MigrationKind;

pub use error::{AppError, AppResult};
pub use db::DbState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("printninja=info".parse().unwrap()),
        )
        .init();

    let migrations = vec![Migration {
        version: 1,
        description: "initial_schema",
        sql: include_str!("db/schema.sql"),
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:printninja.db", migrations)
                .build(),
        )
        .setup(|app| {
            let db_path = app.path().app_data_dir()?.join("printninja.db");
            if let Some(parent) = db_path.parent() {
                std::fs::create_dir_all(parent)?;
            }

            // Create the schema eagerly so rusqlite-backed commands work
            // immediately (the sql plugin only migrates lazily on connect).
            let conn = rusqlite::Connection::open(&db_path)?;
            conn.execute_batch(include_str!("db/schema.sql"))?;
            drop(conn);

            let db_url = format!("sqlite:{}", db_path.display());
            app.manage(Arc::new(Mutex::new(db::Database { url: db_url })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::printer::list_printers,
            commands::printer::add_printer,
            commands::printer::delete_printer,
            commands::template::list_templates,
            commands::template::create_template,
            commands::template::delete_template,
            commands::history::list_jobs,
            commands::history::get_job,
            commands::history::reprint_job,
            commands::history::retry_job,
            commands::history::delete_job,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::print::print_html,
            commands::print::enumerate_system_printers,
            commands::print::spike_test_print,
            commands::version::list_versions,
            commands::version::create_version,
            commands::version::delete_version,
            commands::version::restore_version,
            commands::font::list_fonts,
            commands::font::upload_font,
            commands::font::delete_font,
            commands::profile::list_profiles,
            commands::profile::save_profile,
            commands::profile::delete_profile,
            commands::batch::create_batch,
            commands::batch::list_batches,
            commands::batch::get_batch,
            commands::batch::cancel_batch,
            commands::batch::retry_batch,
            commands::api::start_api_server,
            commands::api::stop_api_server,
            commands::api::get_api_status,
            commands::api::regenerate_api_key,
            commands::deeplink_cmd::parse_deeplink,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
