use std::path::Path;

/// Every command the app registers with `generate_handler!` in src/lib.rs. With an app manifest a window may call only the commands that
/// a capability grants it (capabilities/default.json: the main window, all of them; capabilities/popout.json: the secondary windows, the
/// few they need). A command missing here is not callable from any window; the tests in lib.rs (`capability_tests`) keep this list, the
/// handler and the main capability the same.
const APP_COMMANDS: &[&str] = &[
    "frame_info", "frame_caption_rect", "frame_system_menu", "list_accounts", "add_account", "cancel_add_account", "test_connection", "cancel_test_connection", "google_sign_in", "oauth_cancel", "reauth_account",
    "google_env_configured", "microsoft_sign_in", "microsoft_env_configured", "microsoft_tenant", "discover_server", "update_account",
    "remove_account", "sync_account", "refresh_badge", "test_notification", "notify_permission", "os_color_scheme", "open_notification_settings", "print_html", "mac_menu_state", "notify_caps", "play_notify_sound", "create_mail_folder", "open_external", "copy_text", "read_clipboard_text", "get_autostart", "set_autostart",
    "list_folders", "list_threads", "locate_thread", "get_thread", "get_thread_packed", "thread_action", "prepare_action", "list_senders", "sender_action", "list_blocked", "unblock", "list_remote_ok", "remote_ok_add", "remote_ok_remove", "remote_ok_clear", "list_remote_noauto", "get_auto_pictures", "set_auto_pictures", "list_service_domains", "remote_noauto_add", "remote_noauto_remove",
    "list_rules", "save_rule", "delete_rule", "move_rule", "rule_count", "rule_targets", "get_raw", "reply_headers", "save_attachments", "attachment_save_as", "attachment_save_all",
    "attachment_open", "attachment_reveal", "pick_folder", "inline_image", "send_message", "save_draft", "draft_recipients", "draft_editor_parts", "draft_data", "draft_upload", "discard_draft", "discard_draft_changes",
    "recovery_save", "recovery_clear", "recovery_list", "recovery_load", "recovery_save_draft", "list_outbox", "cancel_outbox", "outbox_pending_count",
    "outbox_open_for_edit", "outbox_release", "outbox_update", "outbox_reschedule", "outbox_retry", "outbox_to_draft", "pgp_list_keys",
    "pgp_generate_key", "pgp_inspect_key", "pgp_import_key", "pgp_import_from_message", "pgp_pick_key_file", "pgp_public_armored",
    "pgp_export_public", "pgp_export_secret", "pgp_delete_key", "pgp_set_verified", "pgp_set_default", "pgp_change_passphrase", "pgp_set_expiry",
    "pgp_unlock", "pgp_lock_all", "pgp_recipient_status", "smtp_size_limit", "pgp_decrypt_message", "outbox_send_now", "outbox_hold",
    "outbox_hold_send", "quit_now", "calendar_list_calendars", "calendar_set_visible", "calendar_list_events", "calendar_get_event",
    "calendar_save_event", "calendar_delete_event", "calendar_respond", "calendar_add_from_message", "calendar_save_ics", "calendar_import_ics",
    "calendar_open_message", "calendar_sources", "calendar_kinds_available", "calendar_connect", "calendar_move_event", "calendar_create_calendar", "calendar_set_color", "calendar_connect_caldav", "calendar_dav_password", "calendar_cancel_connect", "calendar_disconnect", "calendar_set_sync",
    "calendar_sync_now", "list_templates", "save_template", "delete_template", "list_signatures", "save_signature", "delete_signature",
    "get_setting", "set_setting", "first_run_hint", "suggest_contacts", "unsubscribe", "unsubscribe_opened", "fetch_remote_images", "queue_action", "cancel_action",
    "load_older", "prune_to_limit", "server_search", "server_search_cancel", "server_open", "attachment_data", "set_secret", "has_secret", "ai_complete", "ai_cancel", "ai_list_models", "shell_info", "check_update",
    "update_download", "update_cancel", "update_discard", "update_defer", "update_note", "set_mail_available", "take_tray_compose", "frontend_ready", "sends_flushed",
    "quit_page_alive", "popout_flush_alive", "popout_flush_dialog", "popout_flush_done", "popout_save_all", "popout_open", "popout_init",
    "popout_ready", "popout_focus", "popout_close", "popout_park", "popout_destroy", "popout_note", "popout_set_key", "popout_show", "drag_begin", "drag_peek", "drag_take", "drag_end", "popout_request", "popout_reply", "thread_meta", "page_pong", "quit_dialog", "quit_cancelled", "show_window", "page_state", "update_install",
    "update_startup_state", "update_startup_ack", "outbox_busy", "idle_states", "window_theme_refresh", "window_caption_colors",
];

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
    // comctl32 (TaskDialogIndirect, used by the dialog plugin) is loaded on first use instead of at process start. The app has the
    // comctl32 v6 manifest either way; the unit-test executable has none and could not start at all once its tests build a mock
    // Tauri app (STATUS_ENTRYPOINT_NOT_FOUND, see update.rs).
    if std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|v| v == "windows") && std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|v| v == "msvc") {
        println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
        println!("cargo:rustc-link-arg=delayimp.lib");
        println!("cargo:rustc-link-arg=/IGNORE:4199");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS))).expect("failed to run tauri-build")
}
