use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::{AndroidPrintExt, Result};

#[command]
pub(crate) async fn html_to_pdf<R: Runtime>(
    app: AppHandle<R>,
    payload: HtmlToPdfRequest,
) -> Result<HtmlToPdfResponse> {
    // `run_mobile_plugin` blocks until Kotlin answers (up to its 60 s
    // watchdog), so it must not run on an async worker.
    tauri::async_runtime::spawn_blocking(move || app.android_print().html_to_pdf(payload))
        .await
        .map_err(|e| crate::Error::Unavailable(format!("Android render task failed: {e}")))?
}

#[command]
pub(crate) async fn enumerate_usb_printers<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<UsbPrinter>> {
    app.android_print().enumerate_usb_printers()
}

#[command]
pub(crate) async fn test_printer<R: Runtime>(
    _app: AppHandle<R>,
    _payload: TestPrinterRequest,
) -> Result<()> {
    // Reachability is probed by the transport before a job is sent;
    // the command only confirms the plugin round-trip works.
    Ok(())
}

#[command]
pub(crate) async fn start_background_service<R: Runtime>(
    app: AppHandle<R>,
) -> Result<bool> {
    app.android_print().start_background_service()
}

#[command]
pub(crate) async fn stop_background_service<R: Runtime>(
    app: AppHandle<R>,
) -> Result<()> {
    app.android_print().stop_background_service()
}

#[command]
pub(crate) async fn is_background_service_running<R: Runtime>(
    app: AppHandle<R>,
) -> Result<bool> {
    app.android_print().is_background_service_running()
}

#[command]
pub(crate) async fn request_battery_exemption<R: Runtime>(
    app: AppHandle<R>,
) -> Result<bool> {
    app.android_print().request_battery_exemption()
}

#[command]
pub(crate) async fn is_battery_exemption_granted<R: Runtime>(
    app: AppHandle<R>,
) -> Result<bool> {
    app.android_print().is_battery_exemption_granted()
}

/// Both notification-permission commands settle immediately on the
/// Kotlin side (the prompt is system UI and the answer is read back as
/// state), so neither needs `spawn_blocking`.
#[command]
pub(crate) async fn notification_permission_state<R: Runtime>(
    app: AppHandle<R>,
) -> Result<NotificationPermissionStateResponse> {
    app.android_print().notification_permission_state()
}

#[command]
pub(crate) async fn request_notification_permission<R: Runtime>(
    app: AppHandle<R>,
) -> Result<NotificationPermissionResponse> {
    app.android_print().request_notification_permission()
}
