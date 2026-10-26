// Prevents additional console window on Windows in release, DO NOT REMOVE!!
// (The QA kits are debug builds made with `--features gui-subsystem`: also a GUI program, so no console window takes the foreground at a tray start.)
#![cfg_attr(any(not(debug_assertions), feature = "gui-subsystem"), windows_subsystem = "windows")]

fn main() {
    hey_look_lib::run()
}
