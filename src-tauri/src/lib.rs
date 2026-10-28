pub mod api;
pub mod commands;
mod data;
pub mod db;
mod deeplink;
mod error;
pub mod metrics;
pub mod queue;
pub mod readme;
pub mod render;
pub mod transport;
pub mod worker;

use std::sync::{Arc, Mutex};
use tauri::Manager;

pub use db::DbState;
pub use error::{AppError, AppResult};

/// Wraps the generated command handler so every IPC call is logged.
/// A generic fn (rather than a `let`) lets the compiler infer the closure's
/// `Invoke<R>` parameter type, which `generate_handler!` leaves unannotated.
fn with_ipc_logging<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        tracing::info!(command = %invoke.message.command(), "ipc call");
        handler(invoke)
    }
}

/// System-tray icon with Show and Quit. Left-click toggles the main
/// window. Desktop only: mobile uses the Android notification instead.
#[cfg(desktop)]
fn build_tray(app: &tauri::AppHandle) -> AppResult<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    };

    let show = MenuItem::with_id(app, "show", "Show PrintNinja", true, None::<&str>)
        .map_err(|e| AppError::Internal(format!("tray menu failed: {e}")))?;
    let quit = MenuItem::with_id(app, "quit", "Quit PrintNinja", true, None::<&str>)
        .map_err(|e| AppError::Internal(format!("tray menu failed: {e}")))?;
    let menu = Menu::with_items(app, &[&show, &quit])
        .map_err(|e| AppError::Internal(format!("tray menu failed: {e}")))?;

    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("PrintNinja")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(true) {
                        let _ = window.hide();
                    } else {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)
        .map_err(|e| AppError::Internal(format!("tray build failed: {e}")))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("printninja_lib=info".parse().unwrap()),
        )
        .init();

    let builder = tauri::Builder::default();

    // Android printing + background service (no-op stub on desktop).
    let builder = builder.plugin(tauri_plugin_android_print::init());

    // External links (the update badge's release page). Link opening only;
    // updates stay manual, there is no auto-download or install path.
    let builder = builder.plugin(tauri_plugin_opener::init());
    // Phone side of pairing used to scan the PC's QR code; pairing is a
    // typed 8-character code now, so no camera plugin ships anymore
    // (was QR scanner; now 8-char code — see docs/ARCHITECTURE.md §9 Pairing).

    // A second launch (or deeplink) focuses the running window instead of
    // starting a second queue. Required once close-to-tray keeps the
    // process alive after the window is gone.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    // Autostart registration itself (Windows Run key, Linux .desktop).
    // Enabled/disabled from the settings DB, never by install default.
    // The --minimized arg is honored below by hiding the first window.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--minimized"]),
    ));

    builder
        .setup(|app| {
            // Android renders PDFs through the Kotlin plugin's WebView, which
            // the renderer reaches through this handle.
            #[cfg(target_os = "android")]
            render::register_android_app(app.handle().clone());

            let db_path = app.path().app_data_dir()?.join("printninja.db");
            if let Some(parent) = db_path.parent() {
                std::fs::create_dir_all(parent)?;
            }

            // One schema path (P11): `Database::open` applies `schema.sql`
            // and the guarded migrations itself, so nothing else (plugin,
            // tests, setup) may apply schema on its own. It also enables WAL
            // and a busy timeout on the one reused connection.
            let db_url = format!("sqlite:{}", db_path.display());
            let database = db::Database::open(&db_url)?;
            let db_state: DbState = Arc::new(Mutex::new(database));
            app.manage(db_state.clone());

            // Orphaned font files (crashed deletes, failed overwrites) go
            // now: nothing is in flight yet, so unreferenced bytes are safe
            // to remove. Failures only warn — fonts re-download on demand.
            {
                let fonts_dir = app.path().app_data_dir().map(|d| d.join("fonts"));
                if let Ok(dir) = fonts_dir {
                    let guard = db_state
                        .lock()
                        .map_err(|_| error::AppError::Internal("DB lock poisoned".into()))?;
                    commands::font::ensure_fonts_dir(app.handle(), guard.connection());
                    match commands::font::sweep_orphan_font_files(guard.connection(), &dir) {
                        Ok(0) => {}
                        Ok(n) => tracing::info!(n, "removed orphan font files at startup"),
                        Err(e) => tracing::warn!(error = %e, "font orphan sweep failed"),
                    }
                }
            }

            // Retention actually runs: terminal history rows older than
            // `retention_days`, then the oldest beyond `max_records`.
            // Once here, then daily — the Settings values were dead
            // ("stored but not implemented") before this.
            {
                let guard = db_state
                    .lock()
                    .map_err(|_| error::AppError::Internal("DB lock poisoned".into()))?;
                let (days, max) = commands::history::read_retention_prefs(guard.connection());
                match commands::history::purge_old_jobs(guard.connection(), days, max) {
                    Ok((by_age, by_cap)) if by_age + by_cap > 0 => {
                        tracing::info!(by_age, by_cap, "purged old print jobs at startup")
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!(error = %e, "startup history purge failed"),
                }
            }
            {
                let db = db_state.clone();
                tauri::async_runtime::spawn(async move {
                    let mut daily = tokio::time::interval(std::time::Duration::from_secs(86_400));
                    // The first tick fires immediately; consume it so the
                    // startup purge above is not repeated at once.
                    daily.tick().await;
                    loop {
                        daily.tick().await;
                        let outcome = db.lock().ok().and_then(|guard| {
                            let (days, max) =
                                commands::history::read_retention_prefs(guard.connection());
                            commands::history::purge_old_jobs(guard.connection(), days, max).ok()
                        });
                        if let Some((by_age, by_cap)) = outcome {
                            if by_age + by_cap > 0 {
                                tracing::info!(by_age, by_cap, "purged old print jobs (daily)");
                            }
                        }
                    }
                });
            }

            // One shared print queue for the whole app, so the Tauri command
            // handlers, the REST API routes, and reprint/retry rows all
            // serialise per printer instead of interleaving bytes on a
            // thermal head.
            let queue = queue::PrintQueue::new();
            app.manage(queue.clone());

            // Pairing-code window shared by the HTTP routes and the
            // pairing commands (one active code, in memory only).
            app.manage(commands::api::PairingState::default());

            // Auto-start the local API server when the user asked for it
            // (Settings → API, off by default). Spawned: `bind_addr` needs
            // the Tokio reactor, and a busy port must only log — never
            // abort startup.
            {
                let autostart = db_state
                    .lock()
                    .ok()
                    .map(|guard| commands::api::api_autostart_enabled(guard.connection()))
                    .unwrap_or(false);
                if autostart {
                    let handle = app.handle().clone();
                    let db = db_state.clone();
                    let q = queue.clone();
                    tauri::async_runtime::spawn(async move {
                        match commands::api::launch_server(handle, db, q, None, None).await {
                            Ok(addr) => {
                                tracing::info!("API server auto-started on {addr}")
                            }
                            Err(e) => {
                                tracing::warn!(error = %e, "API server auto-start failed")
                            }
                        }
                    });
                }
            }

            // One worker consumes the queued rows reprint and retry write
            // (P3). It replaced a channel whose
            // receiver only logged what it admitted (P8): the database is
            // the queue, the worker is the consumer, and `queue.kick()`
            // wakes it the moment rows appear.
            let cache_dir = app.path().app_cache_dir()?;
            // Profiles left in the cache dir by earlier runs (a render killed
            // mid-flight) carry certificate material that looked like the app
            // wrote a `.pem` file. Nothing is in flight yet — the worker
            // spawns below — so stale ones can go now.
            render::sweep_leftover_edge_profiles(
                &cache_dir,
                std::time::Duration::from_secs(60 * 30),
            );
            // Start the persistent browser now, in the background, so the
            // first print is as fast as the rest. Before the worker so the
            // profile is claimed before any job can ask.
            #[cfg(windows)]
            render::warm_up_edge(cache_dir.clone());
            #[cfg(target_os = "linux")]
            render::warm_up_chromium(cache_dir.clone());
            #[cfg(target_os = "linux")]
            if let Err(e) = render::check_chromium() {
                tracing::warn!(
                    "{e} — printing will fail until a Chromium-family browser is installed (apt install chromium or google-chrome); the AppImage does not bundle one, the .deb declares it"
                );
            }
            worker::spawn(db_state.clone(), queue, cache_dir);

            // Warm the peer capability cache while the app boots, so the
            // first print with paired PCs reuses a known-good probe
            // instead of paying a full timeout behind it. Best-effort and
            // silent: no pairs (or an unreachable PC) is the normal case,
            // and the print path re-probes on its own anyway.
            {
                let db = db_state.clone();
                tauri::async_runtime::spawn(async move {
                    let pairs = db
                        .lock()
                        .ok()
                        .and_then(|guard| {
                            crate::api::peer_consume::load_consumer_config(
                                guard.connection(),
                            )
                        })
                        .unwrap_or_default();
                    if !pairs.is_empty() {
                        let _ = crate::api::peer_consume::probe_candidates(&pairs, true).await;
                    }
                });
            }

            // Sync the OS autostart registration with the settings DB
            // (opt-in; off on fresh installs) and build the tray icon.
            #[cfg(desktop)]
            {
                let prefs = commands::background::read_prefs(app.handle());
                let _ =
                    commands::background::apply_autostart(app.handle(), prefs.launch_at_startup);
                build_tray(app.handle())?;

                // Launched by the OS at login with --minimized, or told
                // to start minimized: stay in the tray instead of
                // popping a window.
                if std::env::args().any(|a| a == "--minimized") || prefs.start_minimized {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(with_ipc_logging(tauri::generate_handler![
            commands::ping,
            commands::background::refresh_background,
            commands::printer::list_printers,
            commands::printer::add_printer,
            commands::printer::update_printer,
            commands::printer::delete_printer,
            commands::printer::get_printer,
            commands::printer::test_printer,
            commands::template::list_templates,
            commands::template::create_template,
            commands::template::get_template,
            commands::template::update_readme,
            commands::template::update_template_meta,
            commands::template::set_publish_info,
            commands::template::clear_publish_info,
            commands::template::update_template_origin,
            commands::template::delete_template,
            commands::history::list_jobs,
            commands::history::get_job,
            commands::history::reprint_job,
            commands::history::retry_job,
            commands::history::delete_job,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::get_trusted_sources,
            commands::settings::set_trusted_sources,
            commands::cache::cache_apply_changes,
            commands::cache::cache_get_sync_state,
            commands::cache::cache_list_dirty,
            commands::cache::cache_mark_pushed,
            commands::cache::cache_mark_conflicted,
            commands::cache::cache_resolve_conflict,
            commands::cache::cache_queue_use,
            commands::cache::cache_list_queued_uses,
            commands::cache::cache_clear_account,
            commands::reset::reset_database,
            commands::cache::cache_list_tombstoned,
            commands::cache::cache_list_synced,
            commands::cache::cache_forget_template,
            commands::cache::cache_list_conflicted,
            commands::datasets::list_datasets,
            commands::datasets::save_dataset,
            commands::datasets::delete_dataset,
            commands::datasets::cache_list_dirty_datasets,
            commands::datasets::cache_mark_dataset_pushed,
            commands::datasets::cache_list_tombstoned_datasets,
            commands::datasets::cache_list_synced_datasets,
            commands::datasets::cache_forget_dataset,
            commands::print::print_html,
            commands::print::enumerate_system_printers,
            commands::print::discover_network_printers,
            commands::print::spike_test_print,
            commands::font::list_fonts,
            commands::font::upload_font,
            commands::font::delete_font,
            commands::profile::list_profiles,
            commands::profile::save_profile,
            commands::profile::delete_profile,
            commands::profile::cache_list_dirty_profiles,
            commands::profile::cache_mark_profile_pushed,
            commands::profile::cache_list_tombstoned_profiles,
            commands::profile::cache_list_synced_profiles,
            commands::profile::cache_forget_profile,
            commands::settings::cache_list_dirty_settings,
            commands::settings::cache_mark_setting_pushed,
            commands::settings::cache_list_tombstoned_settings,
            commands::settings::cache_list_synced_settings,
            commands::settings::cache_forget_setting,
            commands::font::cache_list_dirty_fonts,
            commands::font::cache_mark_font_pushed,
            commands::font::cache_list_tombstoned_fonts,
            commands::font::cache_list_synced_fonts,
            commands::font::cache_forget_font,
            commands::font::cache_read_font_file,
            commands::font::cache_download_pending_fonts,
            commands::api::start_api_server,
            commands::api::stop_api_server,
            commands::api::get_api_status,
            commands::api::api_request,
            commands::api::get_render_status,
            commands::api::set_render_sharing,
            commands::api::start_pairing,
            commands::api::cancel_pairing,
            commands::api::get_pairing_state,
            commands::api::list_paired_devices,
            commands::api::revoke_paired_device,
            commands::api::clear_paired_devices,
            commands::api::rename_paired_device,
            commands::api::pair_with_code,
            commands::api::peer_capabilities,
            commands::api::peer_render_request,
            commands::deeplink_cmd::parse_deeplink,
        ]))
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The persistent browser must not outlive the app.
            #[cfg(any(windows, target_os = "linux"))]
            if matches!(event, tauri::RunEvent::Exit) {
                #[cfg(windows)]
                render::shutdown_edge();
                #[cfg(target_os = "linux")]
                render::shutdown_chromium();
            }
            // Desktop window behavior for tray mode. Close hides instead
            // of quitting when close_to_tray is on (the default); a
            // minimize hides when minimize_to_tray is on. There is no
            // minimized window event, so a focus loss while minimized
            // stands in for it.
            #[cfg(desktop)]
            if let tauri::RunEvent::WindowEvent { label, event, .. } = &event {
                if label == "main" {
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            let prefs = commands::background::read_prefs(app);
                            if prefs.close_to_tray {
                                api.prevent_close();
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.hide();
                                }
                            }
                        }
                        tauri::WindowEvent::Focused(false) => {
                            let prefs = commands::background::read_prefs(app);
                            if prefs.minimize_to_tray {
                                if let Some(window) = app.get_webview_window("main") {
                                    if window.is_minimized().unwrap_or(false) {
                                        let _ = window.hide();
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            #[cfg(not(desktop))]
            let _ = (app, event);
        });
}
