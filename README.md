# Grain Studio

Local VSCO-Studio-style photo editor. Tauri 2 (Rust) + React + raw WebGL2.

- Build: `npm install` then `npm run release` → `src-tauri/target/release/grain-studio.exe`
- Dev: `npx tauri dev`
- Library lives in `Pictures\Grain Studio` (originals, thumbs, per-photo edit JSON, luts, Exports). Autosaves.
- Preset Lab: capture chart (33³ lattice, 16px JPEG-aligned patches) → apply preset in studio.vsco.co → export → import → `.cube`.
