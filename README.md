# Grain Studio

A local photo studio for Windows: collect images, edit them with film-style presets, organize them with tags, labels and groups, and track what you've posted. Everything stays on your PC — no account, no cloud, no telemetry.

Built with [Tauri 2](https://tauri.app) (Rust + WebView2), React and raw WebGL2. The whole app is a single ~5 MB executable.

## Features

**Collect**
- Drag images straight out of Chrome/Brave, or paste with `Ctrl+V` — nothing has to be saved first
- Import files and folders from Explorer, including iPhone HEIC (via the OS HEIF/HEVC extensions)
- Every photo records a date: the file's creation time, or when you dragged it in

**Edit** — GPU pipeline, one fragment shader pass per frame
- Presets as 3D LUTs, with a strength slider and live per-preset previews
- Exposure, contrast, highlights, shadows, fade, temperature, tint, saturation, skin tone
- Clarity, sharpen, vignette, grain, split tone, HSL, tone curve (RGB + per channel)
- Crop, straighten, rotate, flip; histogram; hold-to-compare and a split before/after view
- Non-destructive: originals are never modified, and every edit autosaves to disk

**Organize**
- Tags, colored labels, groups (albums), search and sort
- Library grouped by day, with month/year navigation
- Mark photos posted per platform, with a prompt right after you drag one out

**Share**
- Drag the edited photo straight into another app, or copy it to the clipboard
- Export with in-app file naming (including a random 15-character name), size, format and quality

## Build

Requires [Rust](https://rustup.rs), Node 20+ and the MSVC build tools.

```bash
npm install
npm run release
```

The executable lands at `src-tauri/target/release/grain-studio.exe`. Copy it anywhere and run it.

For development:

```bash
npx tauri dev
```

## Where your files live

The app keeps a library folder at `Pictures\Grain Studio`:

| Folder / file | Contents |
| --- | --- |
| `originals/` | Untouched copies of imported photos |
| `previews/`, `thumbs/` | Generated previews and thumbnails |
| `edits/` | One small JSON file of edit settings per photo |
| `luts/` | Your presets as `.cube` files |
| `library.json` | Photo records: dates, tags, labels, groups, posted status |
| `collections.json` | Label and group definitions |
| `Exports/` | Default export destination |

None of this is part of the repository.

## Presets

18 film-style looks are generated procedurally at runtime — no LUT files are bundled.

The **Preset Lab** turns presets from your own VSCO account into local ones: save the capture chart (a 3168×2912 grid of 36,000 color patches), run it through a preset in VSCO at full strength, export it, and import the result. Grain Studio reads the color shift back out as a `.cube` LUT. It captures color only, so grain, fade and clarity are recreated with the sliders. Captured presets are for personal use and shouldn't be redistributed. You can also import any `.cube` LUT directly.

## Architecture

```
src/
  gl/          WebGL2 renderer + shaders (the whole edit pipeline)
  lib/         state store, autosave, import, LUTs, sharing, organizing
  components/  React UI
  workers/     thumbnail + export workers (off the main thread)
src-tauri/     Rust: file IO, parallel import, HEIC decode, downloads
```

Editing renders a ~2560px preview; full resolution loads only on zoom or export. Exports render in a worker so the UI stays responsive.

## License

MIT — see [LICENSE](LICENSE).
