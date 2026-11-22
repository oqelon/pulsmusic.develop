// Список своих команд — чтобы доступ к ним выдавался только через capabilities (окну «Лаборатория звука»).
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["pick_files", "save_report", "env_info", "open_ui","ya_fmt","lab_streams","lab_ya_log","lab_ya_log_last","lab_ya_recent","ya_add","token_set","ya_login","engine_create","engine_drop","engine_open","engine_play","engine_pause","engine_seek","engine_volume","engine_rate","engine_state","engine_eq","engine_tap","engine_info","engine_devices","engine_set_device"]),
        ),
    )
    .expect("tauri-build");
}
