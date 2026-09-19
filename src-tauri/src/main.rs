#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Thin native layer: file IO for the library folder. All imaging runs on the GPU in the webview.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "jfif", "png", "webp", "bmp", "gif", "avif"];
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn ext_of(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

/// Write via temp file + rename so a crash never leaves a half-written file.
fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{n}.tmp"));
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, data)?;
    if fs::rename(&tmp, path).is_err() {
        // Target may be momentarily locked (e.g. being read); fall back to a direct write.
        let res = fs::write(path, data);
        let _ = fs::remove_file(&tmp);
        return res;
    }
    Ok(())
}

fn unique_path(p: PathBuf) -> PathBuf {
    if !p.exists() {
        return p;
    }
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("image").to_string();
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_string();
    let dir = p.parent().map(Path::to_path_buf).unwrap_or_default();
    (1..)
        .map(|i| {
            let name = if ext.is_empty() { format!("{stem}-{i}") } else { format!("{stem}-{i}.{ext}") };
            dir.join(name)
        })
        .find(|c| !c.exists())
        .unwrap()
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn library_root(app: tauri::AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .picture_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(err)?;
    let root = base.join("Grain Studio");
    for d in ["originals", "thumbs", "edits", "luts", "Exports"] {
        fs::create_dir_all(root.join(d)).map_err(err)?;
    }
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command]
async fn read_text(path: String) -> Result<Option<String>, String> {
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

#[tauri::command]
async fn write_text(path: String, contents: String) -> Result<(), String> {
    atomic_write(Path::new(&path), contents.as_bytes()).map_err(err)
}

/// Reads every `*.ext` file in a directory in one round trip: stem -> contents.
#[tauri::command]
async fn read_all_text(dir: String, ext: String) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    let rd = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(err(e)),
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if !ext_of(&p).eq_ignore_ascii_case(&ext) {
            continue;
        }
        if let (Some(stem), Ok(txt)) = (p.file_stem().and_then(|s| s.to_str()), fs::read_to_string(&p)) {
            out.insert(stem.to_string(), txt);
        }
    }
    Ok(out)
}

#[tauri::command]
async fn list_dir(dir: String, ext: String) -> Result<Vec<String>, String> {
    let rd = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(err(e)),
    };
    let mut out: Vec<String> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && ext_of(p).eq_ignore_ascii_case(&ext))
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(String::from))
        .collect();
    out.sort_by_key(|s| s.to_lowercase());
    Ok(out)
}

/// Raw bytes to JS as an ArrayBuffer (no base64/JSON overhead).
#[tauri::command]
async fn read_bytes(path: String) -> Result<Response, String> {
    fs::read(&path).map(Response::new).map_err(err)
}

/// Raw body upload. Headers: `x-path` (URI-encoded), optional `x-unique` to avoid overwriting.
#[tauri::command]
async fn write_bytes(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw body".into());
    };
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(pct_decode)
        .ok_or("missing x-path header")?;
    let mut p = PathBuf::from(path);
    if request.headers().get("x-unique").is_some() {
        p = unique_path(p);
    }
    atomic_write(&p, data).map_err(err)?;
    Ok(p.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Imported {
    id: String,
    path: String,
    name: String,
    size: u64,
}

fn collect_images(p: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    if p.is_dir() {
        if depth > 8 {
            return;
        }
        if let Ok(rd) = fs::read_dir(p) {
            let mut kids: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
            kids.sort();
            for k in kids {
                collect_images(&k, out, depth + 1);
            }
        }
    } else if IMAGE_EXTS.contains(&ext_of(p).as_str()) {
        out.push(p.to_path_buf());
    }
}

/// Copies files (folders are walked) into the library in parallel. `skip` holds "name|size" keys already present.
#[tauri::command]
async fn import_files(paths: Vec<String>, dest: String, skip: Vec<String>) -> Result<Vec<Imported>, String> {
    let mut seen: HashSet<String> = skip.into_iter().collect();
    let mut files = Vec::new();
    for p in &paths {
        collect_images(Path::new(p), &mut files, 0);
    }
    fs::create_dir_all(&dest).map_err(err)?;
    let base = now_ms();
    let mut jobs = Vec::new();
    for (i, f) in files.iter().enumerate() {
        let size = fs::metadata(f).map(|m| m.len()).unwrap_or(0);
        let name = f.file_name().and_then(|s| s.to_str()).unwrap_or("image").to_string();
        if !seen.insert(format!("{name}|{size}")) {
            continue;
        }
        let id = format!("{base:x}{i:05x}");
        let dst = Path::new(&dest).join(format!("{id}.{}", ext_of(f)));
        let info = Imported { id, path: dst.to_string_lossy().into_owned(), name, size };
        jobs.push((f.clone(), dst, info));
    }
    if jobs.is_empty() {
        return Ok(vec![]);
    }
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    let chunk = jobs.len().div_ceil(threads);
    let results: Vec<Imported> = std::thread::scope(|s| {
        let handles: Vec<_> = jobs
            .chunks(chunk)
            .map(|c| {
                s.spawn(move || {
                    c.iter()
                        .filter(|(src, dst, _)| fs::copy(src, dst).is_ok())
                        .map(|(_, _, info)| Imported {
                            id: info.id.clone(),
                            path: info.path.clone(),
                            name: info.name.clone(),
                            size: info.size,
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    });
    Ok(results)
}

#[tauri::command]
async fn remove_paths(paths: Vec<String>) -> Result<(), String> {
    for p in paths {
        let _ = fs::remove_file(p);
    }
    Ok(())
}

#[tauri::command]
async fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err("A file with that name already exists".into());
    }
    fs::rename(from, to).map_err(err)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    std::process::Command::new("explorer").arg(path).spawn().map(|_| ()).map_err(err)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            library_root,
            read_text,
            write_text,
            read_all_text,
            list_dir,
            read_bytes,
            write_bytes,
            import_files,
            remove_paths,
            rename_path,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running Grain Studio");
}
