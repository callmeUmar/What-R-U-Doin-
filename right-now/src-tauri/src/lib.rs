use tauri::{Emitter, Manager};

mod dictation;

#[cfg(desktop)]
use tauri_plugin_autostart::MacosLauncher;

/// The key you press anywhere in the OS to start or stop the count.
const HOTKEY: &str = "CmdOrCtrl+Shift+Space";

pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                None,
            ))
            .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        .manage(dictation::Dictation::default())
        .invoke_handler(tauri::generate_handler![
            dictation::model_ready,
            dictation::download_model,
            dictation::transcribe
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::ManagerExt;
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

                // Open with the machine. Safe to call every launch.
                let auto = app.autolaunch();
                if !auto.is_enabled().unwrap_or(false) {
                    let _ = auto.enable();
                }

                let shortcut: Shortcut = HOTKEY.parse()?;
                let handle = app.handle().clone();

                // If another app already owns this combo, registration fails
                // quietly — so say so rather than wondering later.
                match app.global_shortcut().on_shortcut(shortcut, move |_app, _sc, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if let Some(win) = handle.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                        let _ = win.emit("toggle-timer", ());
                    }
                }) {
                    Ok(_) => println!("hotkey {HOTKEY} is live"),
                    Err(e) => eprintln!("could not claim {HOTKEY}: {e} — pick another one"),
                }
            }
            Ok(())
        })
        // Closing the window puts it away instead of quitting, so a running
        // count survives until you actually shut the machine down.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Right Now");
}
