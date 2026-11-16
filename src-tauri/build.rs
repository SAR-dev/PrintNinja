fn main() {
    // On Windows (MSVC), tauri/wry/muda import comctl32 v6 entry points
    // (e.g. TaskDialogIndirect). Those only resolve when the executable
    // carries a Common-Controls v6 manifest. `tauri_build` embeds one only
    // in the app binary, so the `cargo test` lib executable dies with
    // STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) at load time.
    //
    // Fix: skip tauri's per-binary manifest and have the linker embed ours
    // into every target (app bin and test executables alike). Checked via
    // CARGO_CFG_* so it keys off the *target*, not the build host.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();

    if target_os == "windows" && target_env == "msvc" {
        let attrs = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attrs).expect("failed to run tauri-build");

        let manifest = std::path::Path::new(
            &std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"),
        )
        .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    } else {
        tauri_build::build();
    }
}
