use anyhow::Result;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp"];

pub fn watch_dir(dir: &Path, mut on_image: impl FnMut(PathBuf)) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = RecommendedWatcher::new(tx, notify::Config::default())?;
    watcher.watch(dir, RecursiveMode::NonRecursive)?;
    let debounce = Duration::from_millis(1250);
    let mut last: HashMap<PathBuf, Instant> = HashMap::new();
    loop {
        let ev = match rx.recv() {
            Ok(Ok(ev)) => ev,
            Ok(Err(err)) => {
                eprintln!("watch error: {err}");
                continue;
            }
            Err(_) => break,
        };
        for path in ev.paths {
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !IMAGE_EXT.contains(&ext.as_str()) {
                continue;
            }
            let now = Instant::now();
            if let Some(prev) = last.get(&path) {
                if now.duration_since(*prev) < debounce {
                    continue;
                }
            }
            last.insert(path.clone(), now);
            std::thread::sleep(Duration::from_millis(400));
            if path.is_file() {
                on_image(path);
            }
        }
    }
    Ok(())
}
