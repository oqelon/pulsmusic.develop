// Пульс на Tauri 2 — точка входа (вся логика в lib.rs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pulse_tauri_lib::run()
}
