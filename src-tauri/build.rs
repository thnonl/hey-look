use std::path::Path;

/// Variables read from the environment (or a `.env` file) at build time and embedded in the binary.
const ENV_KEYS: [&str; 4] = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"];

fn main() {
    for key in ENV_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }
    // `.env` next to package.json (project root) or in src-tauri; real environment variables win.
    for file in ["../.env", ".env"] {
        println!("cargo:rerun-if-changed={file}");
        let Ok(text) = std::fs::read_to_string(Path::new(file)) else { continue };
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((k, v)) = line.split_once('=') else { continue };
            let k = k.trim().trim_start_matches("export ").trim();
            let v = v.trim().trim_matches(['"', '\'']);
            if ENV_KEYS.contains(&k) && !v.is_empty() && std::env::var(k).map_or(true, |e| e.is_empty()) {
                println!("cargo:rustc-env={k}={v}");
            }
        }
    }
    tauri_build::build()
}
