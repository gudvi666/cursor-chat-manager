mod db;

use serde::Serialize;
use std::sync::Mutex;

pub struct AppState {
    db_path: Mutex<String>,
    size_cache: Mutex<Option<std::collections::HashMap<String, (i64, i64)>>>,
    orphan_hashes: Mutex<Option<Vec<String>>>,
}

fn dbp(state: &AppState) -> String {
    state.db_path.lock().unwrap().clone()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConvListResponse {
    conversations: Vec<db::ConvSummary>,
    size_cache_ready: bool,
}

#[tauri::command]
fn get_info(state: tauri::State<AppState>) -> db::DbInfo {
    db::db_info(&dbp(&state))
}

/// 手动设置数据库路径（文件选择器选中后调用）；返回最新库信息
#[tauri::command]
fn set_db_path(state: tauri::State<AppState>, path: String) -> db::DbInfo {
    *state.db_path.lock().unwrap() = path.clone();
    *state.size_cache.lock().unwrap() = None;
    *state.orphan_hashes.lock().unwrap() = None;
    db::db_info(&path)
}

#[tauri::command]
fn get_conversations(state: tauri::State<AppState>) -> Result<ConvListResponse, String> {
    let mut convs = db::list_conversations(&dbp(&state))?;
    let cache = state.size_cache.lock().unwrap();
    let ready = cache.is_some();
    if let Some(map) = cache.as_ref() {
        for c in convs.iter_mut() {
            match map.get(&c.id) {
                Some((n, b)) => { c.message_count = Some(*n); c.size_bytes = Some(*b); }
                None => { c.message_count = Some(0); c.size_bytes = Some(0); }
            }
        }
    }
    Ok(ConvListResponse { conversations: convs, size_cache_ready: ready })
}

#[tauri::command]
fn get_conversation(state: tauri::State<AppState>, id: String) -> Result<db::ConversationData, String> {
    db::get_conversation(&dbp(&state), &id)
}

#[tauri::command]
fn search(state: tauri::State<AppState>, q: String) -> Result<db::SearchResult, String> {
    db::search_messages(&dbp(&state), &q, 300)
}

#[tauri::command]
fn get_stats(state: tauri::State<AppState>) -> Result<db::Stats, String> {
    db::stats_overview(&dbp(&state))
}

#[tauri::command]
fn get_prefix_stats(state: tauri::State<AppState>) -> Result<Vec<db::PrefixStat>, String> {
    db::prefix_stats(&dbp(&state))
}

#[tauri::command]
fn scan_sizes(state: tauri::State<AppState>) -> Result<usize, String> {
    let map = db::scan_sizes(&dbp(&state))?;
    let n = map.len();
    *state.size_cache.lock().unwrap() = Some(map);
    Ok(n)
}

#[tauri::command]
fn backup(state: tauri::State<AppState>) -> Result<String, String> {
    db::backup_db(&dbp(&state))
}

#[tauri::command]
fn vacuum(state: tauri::State<AppState>) -> Result<db::VacuumResult, String> {
    db::vacuum_db(&dbp(&state), false)
}

#[tauri::command]
fn delete_conversations(state: tauri::State<AppState>, ids: Vec<String>, backup: bool, vacuum: bool) -> Result<db::DeleteResult, String> {
    let res = db::delete_conversations(&dbp(&state), &ids, backup, vacuum)?;
    *state.size_cache.lock().unwrap() = None;
    *state.orphan_hashes.lock().unwrap() = None;
    Ok(res)
}

#[tauri::command]
fn agentkv_scan(state: tauri::State<AppState>) -> Result<db::OrphanScan, String> {
    let scan = db::scan_agentkv_orphans(&dbp(&state))?;
    *state.orphan_hashes.lock().unwrap() = Some(scan.orphan_hashes.clone());
    Ok(scan)
}

#[tauri::command]
fn agentkv_purge(state: tauri::State<AppState>, backup: bool, vacuum: bool) -> Result<db::PurgeResult, String> {
    let hashes = state.orphan_hashes.lock().unwrap().clone().ok_or_else(|| "请先扫描孤儿缓存".to_string())?;
    let res = db::delete_agentkv_orphans(&dbp(&state), &hashes, backup, vacuum)?;
    *state.size_cache.lock().unwrap() = None;
    *state.orphan_hashes.lock().unwrap() = None;
    Ok(res)
}

#[tauri::command]
fn export_md(state: tauri::State<AppState>, id: String) -> Result<String, String> {
    db::export_markdown(&dbp(&state), &id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            db_path: Mutex::new(db::default_db_path()),
            size_cache: Mutex::new(None),
            orphan_hashes: Mutex::new(None),
        })
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_info,
            set_db_path,
            get_conversations,
            get_conversation,
            search,
            get_stats,
            get_prefix_stats,
            scan_sizes,
            backup,
            vacuum,
            delete_conversations,
            agentkv_scan,
            agentkv_purge,
            export_md
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
