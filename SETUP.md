# Turning Right Now into a real app

Tauri wraps the React file in a native window. The result is a few megabytes,
opens with the machine, and owns a system-wide hotkey. Budget an hour the first
time, mostly waiting on Rust to compile.

## 1. Install the toolchain

- **Rust** — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Node 20+**
- **macOS** — Xcode command line tools: `xcode-select --install`
- **Windows** — Microsoft C++ Build Tools, and WebView2 (already on Win 11)
- **Linux** — `webkit2gtk-4.1`, `libappindicator3`, `librsvg2`, `patchelf`
  (package names vary by distro; the Tauri prerequisites page lists them)

## 2. Scaffold the project

```sh
npm create tauri-app@latest right-now
```

Choose **React** and **TypeScript or JavaScript — JavaScript** and **Vite**.
Then:

```sh
cd right-now
npm install
```

## 3. Add the two plugins

```sh
cd src-tauri
cargo add tauri-plugin-autostart --target 'cfg(any(target_os = "macos", windows, target_os = "linux"))'
cargo add tauri-plugin-global-shortcut --target 'cfg(any(target_os = "macos", windows, target_os = "linux"))'
cd ..
```

## 4. Drop in the files

| From here | Goes to |
|---|---|
| `right-now.jsx` | `src/RightNow.jsx` |
| `src-tauri/src/lib.rs` | `src-tauri/src/lib.rs` (replace) |
| `src-tauri/tauri.conf.json` | `src-tauri/tauri.conf.json` (replace) |
| `src-tauri/capabilities/default.json` | `src-tauri/capabilities/default.json` (replace) |

Then make `src/App.jsx`:

```jsx
import RightNow from "./RightNow";
export default function App() {
  return <RightNow />;
}
```

Delete the template's `src/App.css` import if it's fighting you — the component
carries its own styling.

## 5. Run it

```sh
npm run tauri dev
```

The window opens. Press **⌘/Ctrl + Shift + Space** from any other app and it
should come forward and start or stop the count. Watch the terminal on first
launch: if the combo is already taken by something else, it says so and you
should pick a different one at the top of `lib.rs`.

## 6. Build the installer

```sh
npm run tauri build
```

Output lands in `src-tauri/target/release/bundle/` — a `.dmg` on macOS, an
`.msi` and `.exe` on Windows, `.deb`/`.AppImage` on Linux. Install it once and
autostart registers itself on first run.

On macOS the app is unsigned, so the first open needs right-click → Open, or
System Settings → Privacy & Security → Open Anyway. For yourself that's fine.
Signing only matters if you hand it to someone else.

## What changed in the app itself

Storage now tries the artifact sandbox first, then falls back to
`localStorage`, which is what it'll actually use inside Tauri. Data lives in
the app's own webview store, so it survives restarts. If you'd rather have a
plain JSON file you can back up, swap `loadState`/`saveState` for
`tauri-plugin-store` or `tauri-plugin-fs`.

The in-window ⌘⇧Space listener is still there for when you're already focused.
The Tauri hotkey fires a `toggle-timer` event that the component listens for.

## The one thing that won't survive the move

**Voice.** `webkitSpeechRecognition` is a browser feature backed by a cloud
service the browser vendor pays for. Neither WKWebView (macOS) nor WebView2
(Windows) gives a wrapped app access to it, and Electron has the same problem.

The app handles this by switching engines: in a browser tab it uses the speech
API, and inside Tauri it records raw audio and runs a local Whisper model.
See **WHISPER.md** for that setup — it's a few more crates and one extra Rust
file, and the result is offline, private, and free.

If you'd rather skip it for now, typing works everywhere, and your OS's own
dictation (Fn twice on macOS, Win+H on Windows) into the text field costs
nothing to set up.
