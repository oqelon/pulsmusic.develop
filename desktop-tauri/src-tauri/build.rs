// Список своих команд — чтобы доступ к ним выдавался только через capabilities (окну «Лаборатория звука»).
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["pick_files", "save_report", "env_info", "open_ui","ya_fmt","lab_streams"]),
        ),
    )
    .expect("tauri-build");
}
