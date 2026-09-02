use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine};
use tauri::{AppHandle, Emitter, Manager, State};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// base.en is the sweet spot for short spoken phrases: ~148 MB, near-instant
/// on any machine from the last decade, and it hears "I'm studying" correctly.
/// Swap to small.en (~488 MB) if you mumble; tiny.en (~78 MB) if you're on a
/// very old laptop and don't mind the odd mangled word.
const MODEL_FILE: &str = "ggml-base.en.bin";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

#[derive(Default)]
pub struct Dictation {
    ctx: Mutex<Option<Arc<WhisperContext>>>,
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(MODEL_FILE))
}

#[tauri::command]
pub fn model_ready(app: AppHandle) -> bool {
    model_path(&app).map(|p| p.exists()).unwrap_or(false)
}

#[tauri::command]
pub async fn download_model(app: AppHandle) -> Result<(), String> {
    let path = model_path(&app)?;
    if path.exists() {
        return Ok(());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let part = path.with_extension("part");
        let mut res = reqwest::blocking::get(MODEL_URL).map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("model download failed: {}", res.status()));
        }
        let total = res.content_length().unwrap_or(0);

        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 1 << 16];
        let mut got: u64 = 0;
        let mut last_pct = -1i64;

        loop {
            let n = res.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            got += n as u64;
            if total > 0 {
                let pct = (got * 100 / total) as i64;
                if pct != last_pct {
                    last_pct = pct;
                    let _ = app.emit("model-progress", pct);
                }
            }
        }
        file.flush().map_err(|e| e.to_string())?;
        drop(file);

        // Only becomes the real file once it's whole, so a killed download
        // doesn't leave something that looks usable.
        std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
        let _ = app.emit("model-progress", 100i64);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn transcribe(
    app: AppHandle,
    dict: State<'_, Dictation>,
    audio: String,
) -> Result<String, String> {
    let path = model_path(&app)?;
    if !path.exists() {
        return Err("The voice model isn't downloaded yet.".into());
    }

    // 16-bit LE mono at 16 kHz, exactly as the front end recorded it.
    let bytes = STANDARD.decode(audio).map_err(|e| e.to_string())?;
    if bytes.len() < 2 {
        return Err("No audio came through.".into());
    }
    let samples: Vec<f32> = bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();

    // Load once, then keep the model warm for the rest of the session.
    let existing = dict.ctx.lock().unwrap().clone();
    let ctx = match existing {
        Some(c) => c,
        None => {
            let p = path.clone();
            let loaded = tauri::async_runtime::spawn_blocking(move || {
                WhisperContext::new_with_params(
                    p.to_str().unwrap_or_default(),
                    WhisperContextParameters::default(),
                )
                .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())??;
            let arc = Arc::new(loaded);
            *dict.ctx.lock().unwrap() = Some(arc.clone());
            arc
        }
    };

    let threads = std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4)
        .min(8);

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(threads);
        params.set_language(Some("en"));
        params.set_translate(false);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);

        let mut state = ctx.create_state().map_err(|e| e.to_string())?;
        state.full(params, &samples).map_err(|e| e.to_string())?;

        let mut out = String::new();
        for segment in state.as_iter() {
            out.push_str(&segment.to_string());
        }

        // Whisper likes to add a trailing period and leading space; the phrase
        // parser is happier without them.
        Ok(out.trim().trim_end_matches('.').trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
