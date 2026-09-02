# Offline dictation with whisper.cpp

This replaces the browser speech API with a local Whisper model. Nothing leaves
the machine, there's no key and no bill, and it works with the network off.

The one-time cost is a ~150 MB model download on first use and a slower first
`cargo build` while whisper.cpp compiles.

## How it fits together

The browser's `MediaRecorder` produces a container format that differs by
platform (WebM/Opus on Windows, MP4/AAC on macOS), and decoding either one in
Rust means dragging in ffmpeg or symphonia. So the app skips it: an
`AudioWorklet` running in an `AudioContext` pinned to 16 kHz hands back raw
float samples, which become 16-bit PCM, then base64, then a Tauri command.
That's exactly the format whisper wants, so the Rust side does no decoding at
all — it just scales integers back to floats and runs the model.

```
mic → AudioContext @16kHz → AudioWorklet → Int16 PCM → base64
    → invoke("transcribe") → whisper-rs → text → the same phrase parser
```

## 1. Extra build tools

whisper.cpp is C++, so `whisper-rs` needs a compiler and CMake on top of what
Tauri already asked for:

- **macOS** — `brew install cmake` (Xcode CLT covers the rest)
- **Windows** — CMake, plus the "Desktop development with C++" workload in
  Visual Studio Build Tools
- **Linux** — `cmake`, `build-essential`, `libclang-dev`

## 2. Crates

```sh
cd src-tauri
cargo add whisper-rs
cargo add base64
cargo add reqwest --no-default-features --features blocking,rustls-tls
cd ..
```

On Apple Silicon, add the Metal feature for a noticeable speedup:

```toml
whisper-rs = { version = "0.16", features = ["metal"] }
```

The first build after this takes several minutes. Later builds are normal.

## 3. Files

| From here | Goes to |
|---|---|
| `src-tauri/src/dictation.rs` | `src-tauri/src/dictation.rs` (new) |
| `src-tauri/src/lib.rs` | `src-tauri/src/lib.rs` (replace) |
| `src-tauri/tauri.conf.json` | `src-tauri/tauri.conf.json` (replace) |
| `right-now.jsx` | `src/RightNow.jsx` (replace) |

On macOS you also need a microphone usage string or the app is killed the
moment it asks for the mic. Create `src-tauri/Info.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSMicrophoneUsageDescription</key>
  <string>Right Now transcribes on this machine. Nothing is sent anywhere.</string>
</dict>
</plist>
```

Tauri merges that into the bundle automatically. (`Info.plist.json` here holds
the same string if you'd rather paste than retype.)

## 4. Use it

```sh
npm run tauri dev
```

Press the mic. The first press downloads the model and shows a percentage in
the hint line under the input; the second press starts recording. Press again
to stop, wait about a second, and the phrase runs through the same parser as
typing — so "I'm studying" starts the count, "stop" ends it, and "I have a
dentist appointment on September 22nd at 3pm" still becomes a calendar event.

## Choosing a model

`dictation.rs` has the filename and URL at the top. For phrases this short:

| Model | Size | Notes |
|---|---|---|
| `ggml-tiny.en.bin` | 78 MB | Fast, but garbles proper nouns |
| `ggml-base.en.bin` | 148 MB | The default. Right for this |
| `ggml-small.en.bin` | 488 MB | Worth it if you mumble or have an accent |

Change both constants together, then delete the old file from the app data
folder so the new one downloads:

- macOS: `~/Library/Application Support/com.yourname.rightnow/`
- Windows: `%APPDATA%\com.yourname.rightnow\`
- Linux: `~/.local/share/com.yourname.rightnow/`

## Things that will bite you

**The model loads on first transcription, not at launch.** That first press
takes an extra second or two while 148 MB comes off disk. It stays warm after
that. Move the load into `setup()` if you'd rather pay it at boot.

**Recording has no time limit.** Press the mic, forget about it, and you'll
hand whisper twenty minutes of audio. Add a `setTimeout` in `whisperVoice` to
auto-stop after fifteen seconds — for phrases this short you'll never hit it.

**Short bursts get padded.** whisper.cpp wants at least a second of audio, so
anything briefer is padded with silence before it goes over. That's already
handled in `startRecording`.

**Accuracy on two-word phrases is worse than on sentences**, because the model
leans on context. If "I'm studying" keeps coming back wrong, saying "I am
studying now" gives it more to work with — or move up to `small.en`.
