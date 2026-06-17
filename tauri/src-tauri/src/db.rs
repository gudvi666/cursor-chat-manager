//! Cursor 对话库数据层 (Rust 版，移植自 Python cursor_db.py)。
//! 直接用 rusqlite 读写 Cursor 的 state.vscdb，无需内嵌 Python。

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;

pub const HEADERS_KEY: &str = "composer.composerHeaders";
pub const ITEM_PANE_PREFIX: &str = "workbench.panel.composerChatViewPane.";
/// 以 composerId 为单位级联清理的键前缀
pub const COMPOSER_SCOPED: &[&str] = &[
    "bubbleId",
    "checkpointId",
    "codeBlockPartialInlineDiffFates",
    "ofsContent",
    "messageRequestContext",
];

// --------------------------------------------------------------------------- //
// 定位 / 进程检测
// --------------------------------------------------------------------------- //

pub fn default_db_path() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    #[cfg(target_os = "macos")]
    let base = home.join("Library/Application Support/Cursor");
    #[cfg(target_os = "windows")]
    let base = dirs::config_dir().unwrap_or_else(|| home.join("AppData/Roaming")).join("Cursor");
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let base = home.join(".config/Cursor");
    base.join("User/globalStorage/state.vscdb")
        .to_string_lossy()
        .to_string()
}

pub fn is_cursor_running() -> bool {
    let me = std::process::id();
    #[cfg(target_os = "windows")]
    {
        if let Ok(o) = Command::new("tasklist").output() {
            return String::from_utf8_lossy(&o.stdout).contains("Cursor.exe");
        }
        return true;
    }
    #[cfg(not(target_os = "windows"))]
    {
        match Command::new("ps").args(["-Ao", "pid=,command="]).output() {
            Ok(o) => {
                let s = String::from_utf8_lossy(&o.stdout);
                for line in s.lines() {
                    let line = line.trim();
                    let mut it = line.splitn(2, char::is_whitespace);
                    let pid = match it.next().and_then(|p| p.trim().parse::<u32>().ok()) {
                        Some(p) => p,
                        None => continue,
                    };
                    let cmd = it.next().unwrap_or("");
                    if pid == me {
                        continue;
                    }
                    let low = cmd.to_lowercase();
                    if low.contains("cursor-chat-manager")
                        || low.contains("cursor chat manager")
                        || low.contains("app.py")
                    {
                        continue;
                    }
                    if low.contains("/cursor.app/") {
                        return true;
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        if (low.contains(".appimage") || low.contains("/cursor")) && low.contains("cursor") {
                            return true;
                        }
                    }
                }
                false
            }
            Err(_) => true,
        }
    }
}

fn open_ro(path: &str) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())
}

pub fn open_rw(path: &str) -> Result<Connection, String> {
    let c = Connection::open(path).map_err(|e| e.to_string())?;
    let _ = c.busy_timeout(std::time::Duration::from_secs(5));
    Ok(c)
}

/// 读取某列为字符串 (TEXT 或 BLOB 都按 UTF-8 处理)
fn col_string(row: &rusqlite::Row, idx: usize) -> String {
    use rusqlite::types::ValueRef;
    match row.get_ref(idx) {
        Ok(ValueRef::Text(b)) | Ok(ValueRef::Blob(b)) => String::from_utf8_lossy(b).to_string(),
        Ok(ValueRef::Null) => String::new(),
        Ok(v) => format!("{:?}", v),
        Err(_) => String::new(),
    }
}

// --------------------------------------------------------------------------- //
// 库信息
// --------------------------------------------------------------------------- //

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbInfo {
    pub path: String,
    pub exists: bool,
    pub cursor_running: bool,
    pub size_bytes: u64,
    pub wal_bytes: u64,
    pub journal_mode: Option<String>,
    pub page_size: Option<i64>,
    pub page_count: Option<i64>,
}

pub fn db_info(path: &str) -> DbInfo {
    let exists = std::path::Path::new(path).exists();
    let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let wal_bytes = std::fs::metadata(format!("{path}-wal")).map(|m| m.len()).unwrap_or(0);
    let (mut journal_mode, mut page_size, mut page_count) = (None, None, None);
    if exists {
        if let Ok(conn) = open_ro(path) {
            journal_mode = conn
                .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
                .ok();
            page_size = conn.query_row("PRAGMA page_size", [], |r| r.get::<_, i64>(0)).ok();
            page_count = conn.query_row("PRAGMA page_count", [], |r| r.get::<_, i64>(0)).ok();
        }
    }
    DbInfo {
        path: path.to_string(),
        exists,
        cursor_running: is_cursor_running(),
        size_bytes,
        wal_bytes,
        journal_mode,
        page_size,
        page_count,
    }
}

// --------------------------------------------------------------------------- //
// 对话列表
// --------------------------------------------------------------------------- //

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvSummary {
    pub id: String,
    pub name: String,
    pub created_at: Option<i64>,
    pub last_updated_at: Option<i64>,
    pub mode: Option<String>,
    pub archived: bool,
    pub message_count: Option<i64>,
    pub size_bytes: Option<i64>,
}

fn read_headers(conn: &Connection) -> Vec<Value> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM ItemTable WHERE key=?1", [HEADERS_KEY], |r| {
            Ok(col_string(r, 0))
        })
        .ok();
    raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("allComposers").and_then(|a| a.as_array().cloned()))
        .unwrap_or_default()
}

pub fn list_conversations(path: &str) -> Result<Vec<ConvSummary>, String> {
    let conn = open_ro(path)?;
    let heads = read_headers(&conn);

    // 新版 Cursor 的 composerHeaders 已不再携带标题字段，标题改存于 composerData.name；
    // 这里一次性批量补读(实测约百毫秒)，作为 header 缺失 name 时的回退来源。
    let mut name_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT substr(key,14), json_extract(value,'$.name') FROM cursorDiskKV \
         WHERE key>='composerData:' AND key<'composerData;'",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        }) {
            for (cid, name) in rows.flatten() {
                if let Some(n) = name {
                    if !n.trim().is_empty() {
                        name_map.insert(cid, n);
                    }
                }
            }
        }
    }

    let mut out = Vec::new();
    for h in heads {
        let id = match h.get("composerId").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        // 标题优先取 header.name(旧数据)，其次回退 composerData.name(新数据)，最后兜底未命名
        let name = h
            .get("name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(String::from)
            .or_else(|| name_map.get(&id).cloned())
            .unwrap_or_else(|| "(未命名)".to_string());
        out.push(ConvSummary {
            id,
            name,
            created_at: h.get("createdAt").and_then(|v| v.as_i64()),
            last_updated_at: h.get("lastUpdatedAt").and_then(|v| v.as_i64()),
            mode: h
                .get("unifiedMode")
                .or_else(|| h.get("forceMode"))
                .and_then(|v| v.as_str())
                .map(String::from),
            archived: h.get("isArchived").and_then(|v| v.as_bool()).unwrap_or(false),
            message_count: None,
            size_bytes: None,
        });
    }
    Ok(out)
}

// --------------------------------------------------------------------------- //
// 对话详情 + 气泡解析 (含 BajieAsk)
// --------------------------------------------------------------------------- //

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thinking {
    pub text: String,
    pub duration_ms: Option<i64>,
}

#[derive(Serialize)]
pub struct ToolCall {
    pub name: Option<String>,
    pub status: Option<String>,
    pub args: String,
    pub result: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Bajie {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received_kind: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub suggestions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedBubble {
    pub id: Option<String>,
    pub role: String,
    pub created_at: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Thinking>,
    pub tool_calls: Vec<ToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bajie: Option<Bajie>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvMeta {
    pub id: String,
    pub name: Option<String>,
    pub created_at: Option<i64>,
    pub last_updated_at: Option<i64>,
    pub status: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub context_tokens_used: Option<i64>,
    pub context_token_limit: Option<i64>,
    pub todos: Vec<Value>,
    pub message_count: usize,
}

#[derive(Serialize)]
pub struct ConversationData {
    pub meta: ConvMeta,
    pub bubbles: Vec<ParsedBubble>,
}

const RESULT_LIMIT: usize = 12000;

fn truncate(s: &str, limit: usize) -> String {
    if s.chars().count() > limit {
        let t: String = s.chars().take(limit).collect();
        format!("{t}\n…(已截断, 共 {} 字符)", s.chars().count())
    } else {
        s.to_string()
    }
}

fn parse_bubble(b: &Value) -> ParsedBubble {
    let btype = b.get("type").and_then(|v| v.as_i64());
    let mut out = ParsedBubble {
        id: b.get("bubbleId").and_then(|v| v.as_str()).map(String::from),
        role: if btype == Some(1) { "user" } else { "assistant" }.to_string(),
        created_at: b.get("createdAt").and_then(|v| v.as_str()).map(String::from),
        text: b.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        thinking: None,
        tool_calls: Vec::new(),
        bajie: None,
        error: None,
    };
    if let Some(th) = b.get("thinking") {
        if let Some(t) = th.get("text").and_then(|v| v.as_str()) {
            if !t.is_empty() {
                out.thinking = Some(Thinking {
                    text: t.to_string(),
                    duration_ms: b.get("thinkingDurationMs").and_then(|v| v.as_i64()),
                });
            }
        }
    }
    if let Some(t) = b.get("toolFormerData") {
        let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(bj) = parse_bajie(name, t) {
            out.bajie = Some(bj);
        } else if !name.is_empty() || t.get("rawArgs").is_some() {
            let args = t
                .get("rawArgs")
                .or_else(|| t.get("params"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let result = match t.get("result") {
                Some(Value::String(s)) => s.clone(),
                Some(v) => v.to_string(),
                None => String::new(),
            };
            out.tool_calls.push(ToolCall {
                name: if name.is_empty() { None } else { Some(name.to_string()) },
                status: t.get("status").and_then(|v| v.as_str()).map(String::from),
                args: truncate(&args, RESULT_LIMIT),
                result: truncate(&result, RESULT_LIMIT),
            });
        }
    }
    if let Some(err) = b.get("errorDetails") {
        out.error = Some(truncate(&err.to_string(), 4000));
    }
    out
}

fn parse_bajie(name: &str, t: &Value) -> Option<Bajie> {
    if !name.to_lowercase().contains("bajieask") {
        return None;
    }
    let args: Value = t
        .get("rawArgs")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .map(|ra| ra.get("args").cloned().unwrap_or(ra))
        .unwrap_or(Value::Null);
    let gs = |k: &str| args.get(k).and_then(|v| v.as_str()).map(String::from);

    if name.contains("reply_message") {
        return Some(Bajie {
            kind: "reply".into(),
            content: Some(args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string()),
            agent_status: gs("agentStatus"),
            ..Default::default()
        });
    }
    if name.contains("wait_message") {
        let received = parse_wait_result(t.get("result"));
        let rk = classify_received(&received);
        return Some(Bajie {
            kind: "wait".into(),
            received: Some(clean_received(&received, &rk)),
            received_kind: Some(rk),
            suggestions: args
                .get("suggestions")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            agent_status: gs("agentStatus"),
            ..Default::default()
        });
    }
    if name.contains("send_to_session") || name.contains("broadcast") {
        let target = args
            .get("targetSessionId")
            .and_then(|v| v.as_str())
            .map(String::from)
            .or_else(|| {
                args.get("targetSessionIds")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(","))
            });
        return Some(Bajie {
            kind: "send".into(),
            message: Some(args.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string()),
            message_type: gs("messageType"),
            target,
            ..Default::default()
        });
    }
    None
}

fn parse_wait_result(res: Option<&Value>) -> String {
    let res = match res {
        Some(r) => r,
        None => return String::new(),
    };
    // 可能是字符串(双层嵌套 JSON)或对象
    let outer: Value = match res {
        Value::String(s) => serde_json::from_str(s).unwrap_or(Value::String(s.clone())),
        v => v.clone(),
    };
    let inner = outer.get("result").cloned().unwrap_or(outer);
    let inner = match inner {
        Value::String(s) => serde_json::from_str(&s).unwrap_or(Value::String(s)),
        v => v,
    };
    if let Some(arr) = inner.get("content").and_then(|c| c.as_array()) {
        return arr
            .iter()
            .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("");
    }
    match inner {
        Value::String(s) => s,
        v => v.to_string(),
    }
}

fn classify_received(text: &str) -> String {
    if text.is_empty() {
        "other"
    } else if text.starts_with("[TIMEOUT]") {
        "timeout"
    } else if text.starts_with("[USER_MSG]") {
        "user"
    } else if text.starts_with("[AUTO_KEEPALIVE]") {
        "keepalive"
    } else if text.starts_with("[FROM:") {
        "inter"
    } else {
        "other"
    }
    .to_string()
}

fn clean_received(text: &str, kind: &str) -> String {
    if kind == "timeout" || kind == "keepalive" {
        return String::new();
    }
    let re = regex::Regex::new(r"^\[USER_MSG\]\[TIME:[^\]]*\]\s*").unwrap();
    let mut s = re.replace(text, "").to_string();
    for marker in ["\n[DISPATCH:", "\n---\n[SYS]", "\n[SYS]", "\n[SYS-RULE]", "\n[ROLE SKILL"] {
        if let Some(i) = s.find(marker) {
            s.truncate(i);
        }
    }
    s.trim().to_string()
}

pub fn get_conversation(path: &str, cid: &str) -> Result<ConversationData, String> {
    let conn = open_ro(path)?;
    let cd_raw: Option<String> = conn
        .query_row(
            "SELECT value FROM cursorDiskKV WHERE key=?1",
            [format!("composerData:{cid}")],
            |r| Ok(col_string(r, 0)),
        )
        .ok();

    // 拉该对话全部气泡到 map
    let lo = format!("bubbleId:{cid}:");
    let hi = format!("bubbleId:{cid};");
    let mut stmt = conn
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key>=?1 AND key<?2")
        .map_err(|e| e.to_string())?;
    let mut map: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let rows = stmt
        .query_map([&lo, &hi], |r| {
            let key = r.get::<_, String>(0)?;
            let val = col_string(r, 1);
            Ok((key, val))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        if let Ok((key, val)) = row {
            if let Some(bid) = key.rsplit(':').next() {
                if let Ok(v) = serde_json::from_str::<Value>(&val) {
                    map.insert(bid.to_string(), v);
                }
            }
        }
    }

    let mut meta = ConvMeta {
        id: cid.to_string(),
        name: None,
        created_at: None,
        last_updated_at: None,
        status: None,
        model: None,
        mode: None,
        context_tokens_used: None,
        context_token_limit: None,
        todos: Vec::new(),
        message_count: 0,
    };
    let mut bubbles = Vec::new();

    if let Some(cd) = cd_raw.and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
        meta.name = cd.get("name").and_then(|v| v.as_str()).map(String::from);
        meta.created_at = cd.get("createdAt").and_then(|v| v.as_i64());
        meta.last_updated_at = cd.get("lastUpdatedAt").and_then(|v| v.as_i64());
        meta.status = cd.get("status").and_then(|v| v.as_str()).map(String::from);
        meta.model = cd.get("modelConfig").and_then(|m| m.get("modelName")).and_then(|v| v.as_str()).map(String::from);
        meta.mode = cd.get("unifiedMode").and_then(|v| v.as_str()).map(String::from);
        meta.context_tokens_used = cd.get("contextTokensUsed").and_then(|v| v.as_i64());
        meta.context_token_limit = cd.get("contextTokenLimit").and_then(|v| v.as_i64());
        meta.todos = cd.get("todos").and_then(|v| v.as_array().cloned()).unwrap_or_default();

        if let Some(headers) = cd.get("fullConversationHeadersOnly").and_then(|v| v.as_array()) {
            for h in headers {
                if let Some(bid) = h.get("bubbleId").and_then(|v| v.as_str()) {
                    if let Some(bv) = map.get(bid) {
                        bubbles.push(parse_bubble(bv));
                    }
                }
            }
        }
    }

    if bubbles.is_empty() && !map.is_empty() {
        let mut all: Vec<Value> = map.into_values().collect();
        all.sort_by(|a, b| {
            a.get("createdAt").and_then(|v| v.as_str()).unwrap_or("")
                .cmp(b.get("createdAt").and_then(|v| v.as_str()).unwrap_or(""))
        });
        bubbles = all.iter().map(parse_bubble).collect();
    }

    meta.message_count = bubbles.len();
    Ok(ConversationData { meta, bubbles })
}

// --------------------------------------------------------------------------- //
// 体积扫描 (每对话气泡数 + 字节)
// --------------------------------------------------------------------------- //

pub fn scan_sizes(path: &str) -> Result<std::collections::HashMap<String, (i64, i64)>, String> {
    let conn = open_ro(path)?;
    let mut stmt = conn
        .prepare(
            "SELECT substr(key,10,36) AS cid, count(*), sum(length(value)) \
             FROM cursorDiskKV WHERE key>='bubbleId:' AND key<'bubbleId;' GROUP BY cid",
        )
        .map_err(|e| e.to_string())?;
    let mut map = std::collections::HashMap::new();
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<i64>>(2)?.unwrap_or(0)))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        if let Ok((cid, n, b)) = row {
            map.insert(cid, (n, b));
        }
    }
    Ok(map)
}

// --------------------------------------------------------------------------- //
// 全文搜索
// --------------------------------------------------------------------------- //

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub name: String,
    pub matches: i64,
    pub snippets: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub query: String,
    pub results: Vec<SearchHit>,
    pub match_count: i64,
    pub conversation_count: usize,
    pub truncated: bool,
}

fn snippet(val: &str, query: &str) -> String {
    let low = val.to_lowercase();
    let ql = query.to_lowercase();
    match low.find(&ql) {
        Some(i) => {
            let start = val[..i].char_indices().rev().take(60).last().map(|(x, _)| x).unwrap_or(0);
            let end_byte = (i + query.len()).min(val.len());
            let end = val[end_byte..].char_indices().nth(60).map(|(x, _)| end_byte + x).unwrap_or(val.len());
            let mut s = val[start..end].replace(['\n', '\r'], " ");
            if start > 0 { s.insert(0, '…'); }
            if end < val.len() { s.push('…'); }
            s
        }
        None => val.chars().take(120).collect(),
    }
}

pub fn search_messages(path: &str, query: &str, limit: i64) -> Result<SearchResult, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchResult { query: String::new(), results: vec![], match_count: 0, conversation_count: 0, truncated: false });
    }
    // 标题映射(主线程一次性读取)
    let conn = open_ro(path)?;
    let heads = read_headers(&conn);
    let mut name_map = std::collections::HashMap::new();
    for h in heads {
        if let Some(id) = h.get("composerId").and_then(|v| v.as_str()) {
            name_map.insert(id.to_string(), h.get("name").and_then(|v| v.as_str()).unwrap_or("(未命名)").to_string());
        }
    }
    drop(conn);

    // value LIKE '%q%' 前导通配符无法走索引，单线程罕见词需全表扫描(~2s)；
    // 这里按 composerId 首字符把 bubbleId 键空间分 4 段，各自独立只读连接并行扫描后合并，约降至 1/4 耗时。
    let like = format!("%{query}%");
    let segments = [
        ("bubbleId:", "bubbleId:4"),
        ("bubbleId:4", "bubbleId:8"),
        ("bubbleId:8", "bubbleId:c"),
        ("bubbleId:c", "bubbleId;"),
    ];
    let mut handles = Vec::new();
    for (lo, hi) in segments {
        let p = path.to_string();
        let like = like.clone();
        let (lo, hi) = (lo.to_string(), hi.to_string());
        handles.push(std::thread::spawn(move || -> Vec<(String, String)> {
            let conn = match open_ro(&p) {
                Ok(c) => c,
                Err(_) => return Vec::new(),
            };
            let mut out = Vec::new();
            if let Ok(mut stmt) = conn.prepare(
                "SELECT key, value FROM cursorDiskKV WHERE key>=?1 AND key<?2 AND value LIKE ?3 LIMIT ?4",
            ) {
                if let Ok(rows) = stmt.query_map(rusqlite::params![lo, hi, like, limit], |r| {
                    Ok((r.get::<_, String>(0)?, col_string(r, 1)))
                }) {
                    for row in rows.flatten() {
                        out.push(row);
                    }
                }
            }
            out
        }));
    }

    let mut by_conv: std::collections::HashMap<String, SearchHit> = std::collections::HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut matched = 0i64;
    for handle in handles {
        for (key, val) in handle.join().unwrap_or_default() {
            let parts: Vec<&str> = key.splitn(3, ':').collect();
            if parts.len() < 3 { continue; }
            let cid = parts[1].to_string();
            matched += 1;
            let entry = by_conv.entry(cid.clone()).or_insert_with(|| {
                order.push(cid.clone());
                SearchHit { id: cid.clone(), name: name_map.get(&cid).cloned().unwrap_or_else(|| "(未命名)".into()), matches: 0, snippets: vec![] }
            });
            entry.matches += 1;
            if entry.snippets.len() < 3 {
                entry.snippets.push(snippet(&val, query));
            }
        }
    }
    let mut results: Vec<SearchHit> = order.into_iter().filter_map(|c| by_conv.remove(&c)).collect();
    results.sort_by(|a, b| b.matches.cmp(&a.matches));
    Ok(SearchResult { query: query.to_string(), conversation_count: results.len(), match_count: matched, truncated: matched >= limit, results })
}

// --------------------------------------------------------------------------- //
// 统计
// --------------------------------------------------------------------------- //

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub total_conversations: usize,
    pub conversations_with_body: i64,
    pub total_messages: i64,
    pub by_model: Vec<(String, i64)>,
    pub by_day: Vec<(String, i64)>,
}

pub fn stats_overview(path: &str) -> Result<Stats, String> {
    use chrono::TimeZone;
    let conn = open_ro(path)?;
    let heads = read_headers(&conn);
    let total_conversations = heads.len();
    let mut by_day: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for h in &heads {
        if let Some(ts) = h.get("createdAt").and_then(|v| v.as_i64()) {
            if let chrono::LocalResult::Single(dt) = chrono::Local.timestamp_millis_opt(ts) {
                *by_day.entry(dt.format("%Y-%m-%d").to_string()).or_insert(0) += 1;
            }
        }
    }
    let mut by_day: Vec<(String, i64)> = by_day.into_iter().collect();
    by_day.sort_by(|a, b| b.0.cmp(&a.0));
    by_day.truncate(30);

    let total_messages: i64 = conn
        .query_row("SELECT count(*) FROM cursorDiskKV WHERE key>='bubbleId:' AND key<'bubbleId;'", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT value FROM cursorDiskKV WHERE key>='composerData:' AND key<'composerData;'")
        .map_err(|e| e.to_string())?;
    let mut by_model: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let rows = stmt.query_map([], |r| Ok(col_string(r, 0))).map_err(|e| e.to_string())?;
    let mut with_body = 0i64;
    for row in rows {
        if let Ok(s) = row {
            if let Ok(cd) = serde_json::from_str::<Value>(&s) {
                with_body += 1;
                let m = cd.get("modelConfig").and_then(|m| m.get("modelName")).and_then(|v| v.as_str()).unwrap_or("(未知)").to_string();
                *by_model.entry(m).or_insert(0) += 1;
            }
        }
    }
    let mut by_model: Vec<(String, i64)> = by_model.into_iter().collect();
    by_model.sort_by(|a, b| b.1.cmp(&a.1));

    Ok(Stats { total_conversations, conversations_with_body: with_body, total_messages, by_model, by_day })
}

#[derive(Serialize)]
pub struct PrefixStat {
    pub pfx: String,
    pub n: i64,
    pub bytes: i64,
}

pub fn prefix_stats(path: &str) -> Result<Vec<PrefixStat>, String> {
    let conn = open_ro(path)?;
    let mut stmt = conn
        .prepare(
            "SELECT CASE WHEN instr(key,':')>0 THEN substr(key,1,instr(key,':')-1) ELSE '(no-colon)' END AS pfx, \
             count(*), sum(length(value)) FROM cursorDiskKV GROUP BY pfx ORDER BY sum(length(value)) DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(PrefixStat { pfx: r.get(0)?, n: r.get(1)?, bytes: r.get::<_, Option<i64>>(2)?.unwrap_or(0) }))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// --------------------------------------------------------------------------- //
// 备份 / VACUUM / 删除
// --------------------------------------------------------------------------- //

pub fn backup_db(path: &str) -> Result<String, String> {
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let dest = format!("{path}.ccm-backup-{ts}");
    let src = open_ro(path)?;
    src.backup(rusqlite::DatabaseName::Main, &dest, None).map_err(|e| e.to_string())?;
    Ok(dest)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VacuumResult {
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub freed_bytes: i64,
}

pub fn vacuum_db(path: &str, allow_when_running: bool) -> Result<VacuumResult, String> {
    if !allow_when_running && is_cursor_running() {
        return Err("Cursor 正在运行, 禁止 VACUUM。请先完全退出 Cursor。".into());
    }
    let before = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let conn = open_rw(path)?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;").map_err(|e| e.to_string())?;
    drop(conn);
    let after = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Ok(VacuumResult { before_bytes: before, after_bytes: after, freed_bytes: before as i64 - after as i64 })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub deleted_conversations: usize,
    pub deleted_keys: i64,
    pub removed_from_index: i64,
    pub backup_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vacuum: Option<VacuumResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vacuum_error: Option<String>,
}

pub fn delete_conversations(path: &str, ids: &[String], do_backup: bool, vacuum: bool) -> Result<DeleteResult, String> {
    use rusqlite::OptionalExtension;
    if ids.is_empty() {
        return Ok(DeleteResult { deleted_conversations: 0, deleted_keys: 0, removed_from_index: 0, backup_path: None, vacuum: None, vacuum_error: None });
    }
    if is_cursor_running() {
        return Err("Cursor 正在运行, 禁止删除。请先完全退出 Cursor。".into());
    }
    let backup_path = if do_backup { Some(backup_db(path)?) } else { None };
    let mut conn = open_rw(path)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut deleted_keys = 0i64;
    for cid in ids {
        deleted_keys += tx.execute("DELETE FROM cursorDiskKV WHERE key=?1", [format!("composerData:{cid}")]).map_err(|e| e.to_string())? as i64;
        for pfx in COMPOSER_SCOPED {
            let lo = format!("{pfx}:{cid}:");
            let hi = format!("{pfx}:{cid};");
            deleted_keys += tx.execute("DELETE FROM cursorDiskKV WHERE key>=?1 AND key<?2", [lo, hi]).map_err(|e| e.to_string())? as i64;
        }
        deleted_keys += tx.execute("DELETE FROM ItemTable WHERE key=?1", [format!("{ITEM_PANE_PREFIX}{cid}.hidden")]).map_err(|e| e.to_string())? as i64;
    }
    let mut removed_from_index = 0i64;
    let raw: Option<String> = tx.query_row("SELECT value FROM ItemTable WHERE key=?1", [HEADERS_KEY], |r| Ok(col_string(r, 0))).optional().map_err(|e| e.to_string())?;
    if let Some(raw) = raw {
        if let Ok(mut data) = serde_json::from_str::<Value>(&raw) {
            if let Some(arr) = data.get("allComposers").and_then(|a| a.as_array()) {
                let before = arr.len();
                let idset: std::collections::HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
                let kept: Vec<Value> = arr.iter().filter(|c| !c.get("composerId").and_then(|v| v.as_str()).map(|s| idset.contains(s)).unwrap_or(false)).cloned().collect();
                removed_from_index = (before - kept.len()) as i64;
                data["allComposers"] = Value::Array(kept);
                tx.execute("UPDATE ItemTable SET value=?1 WHERE key=?2", rusqlite::params![data.to_string(), HEADERS_KEY]).map_err(|e| e.to_string())?;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    drop(conn);

    let mut res = DeleteResult { deleted_conversations: ids.len(), deleted_keys, removed_from_index, backup_path, vacuum: None, vacuum_error: None };
    if vacuum {
        match vacuum_db(path, true) {
            Ok(v) => res.vacuum = Some(v),
            Err(e) => res.vacuum_error = Some(e),
        }
    }
    Ok(res)
}

// --------------------------------------------------------------------------- //
// agentKv 孤儿缓存回收
// --------------------------------------------------------------------------- //

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanScan {
    pub total_blobs: i64,
    pub total_bytes: i64,
    pub orphan_count: i64,
    pub orphan_bytes: i64,
    #[serde(skip)]
    pub orphan_hashes: Vec<String>,
}

pub fn scan_agentkv_orphans(path: &str) -> Result<OrphanScan, String> {
    let conn = open_ro(path)?;
    let mut akv: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT key, length(value) FROM cursorDiskKV WHERE key>='agentKv:' AND key<'agentKv;'").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(|e| e.to_string())?;
        for row in rows {
            if let Ok((k, n)) = row {
                if let Some(h) = k.rsplit(':').next() {
                    akv.insert(h.to_string(), n);
                }
            }
        }
    }
    let re = regex::Regex::new(r"[0-9a-f]{64}").unwrap();
    let mut referenced: std::collections::HashSet<String> = std::collections::HashSet::new();
    {
        let mut stmt = conn.prepare("SELECT value FROM cursorDiskKV WHERE key<'agentKv:' OR key>='agentKv;'").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(col_string(r, 0))).map_err(|e| e.to_string())?;
        for row in rows {
            if let Ok(s) = row {
                for m in re.find_iter(&s) {
                    referenced.insert(m.as_str().to_string());
                }
            }
        }
    }
    let orphan_hashes: Vec<String> = akv.keys().filter(|h| !referenced.contains(*h)).cloned().collect();
    let orphan_bytes: i64 = orphan_hashes.iter().map(|h| akv.get(h).copied().unwrap_or(0)).sum();
    Ok(OrphanScan {
        total_blobs: akv.len() as i64,
        total_bytes: akv.values().sum(),
        orphan_count: orphan_hashes.len() as i64,
        orphan_bytes,
        orphan_hashes,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    pub deleted_blobs: i64,
    pub backup_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vacuum: Option<VacuumResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vacuum_error: Option<String>,
}

pub fn delete_agentkv_orphans(path: &str, hashes: &[String], do_backup: bool, vacuum: bool) -> Result<PurgeResult, String> {
    if hashes.is_empty() {
        return Ok(PurgeResult { deleted_blobs: 0, backup_path: None, vacuum: None, vacuum_error: None });
    }
    if is_cursor_running() {
        return Err("Cursor 正在运行, 禁止清理缓存。请先完全退出 Cursor。".into());
    }
    let backup_path = if do_backup { Some(backup_db(path)?) } else { None };
    let mut conn = open_rw(path)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut deleted = 0i64;
    {
        let mut stmt = tx.prepare("DELETE FROM cursorDiskKV WHERE key=?1").map_err(|e| e.to_string())?;
        for h in hashes {
            deleted += stmt.execute([format!("agentKv:blob:{h}")]).map_err(|e| e.to_string())? as i64;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    drop(conn);
    let mut res = PurgeResult { deleted_blobs: deleted, backup_path, vacuum: None, vacuum_error: None };
    if vacuum {
        match vacuum_db(path, true) {
            Ok(v) => res.vacuum = Some(v),
            Err(e) => res.vacuum_error = Some(e),
        }
    }
    Ok(res)
}

// --------------------------------------------------------------------------- //
// 导出 Markdown
// --------------------------------------------------------------------------- //

pub fn export_markdown(path: &str, cid: &str) -> Result<String, String> {
    let data = get_conversation(path, cid)?;
    let m = &data.meta;
    let mut s = String::new();
    s.push_str(&format!("# {}\n\n", m.name.clone().unwrap_or_else(|| "(未命名)".into())));
    let mut info = Vec::new();
    if let Some(md) = &m.model { info.push(format!("模型 `{md}`")); }
    if let Some(mode) = &m.mode { info.push(format!("模式 `{mode}`")); }
    info.push(format!("{} 条消息", m.message_count));
    s.push_str(&format!("> {}\n\n", info.join(" · ")));
    if !m.todos.is_empty() {
        s.push_str("## Todos\n");
        for td in &m.todos {
            let done = td.get("status").and_then(|v| v.as_str()) == Some("completed");
            let content = td.get("content").and_then(|v| v.as_str()).unwrap_or("");
            s.push_str(&format!("- [{}] {}\n", if done { "x" } else { " " }, content));
        }
        s.push('\n');
    }
    s.push_str("---\n\n");
    for b in &data.bubbles {
        // BajieAsk 还原
        if let Some(bj) = &b.bajie {
            match bj.kind.as_str() {
                "reply" => { s.push_str("### 🤖 Cursor\n\n"); s.push_str(bj.content.as_deref().unwrap_or("")); s.push_str("\n\n"); }
                "wait" => {
                    if bj.received_kind.as_deref() == Some("user") {
                        s.push_str("### 👤 用户\n\n");
                        s.push_str(bj.received.as_deref().unwrap_or(""));
                        s.push_str("\n\n");
                    }
                }
                "send" => { s.push_str(&format!("### 📤 发送给 {}\n\n", bj.target.clone().unwrap_or_default())); s.push_str(bj.message.as_deref().unwrap_or("")); s.push_str("\n\n"); }
                _ => {}
            }
            continue;
        }
        let has = !b.text.is_empty() || b.thinking.is_some() || !b.tool_calls.is_empty() || b.error.is_some();
        if !has { continue; }
        s.push_str(if b.role == "user" { "### 👤 用户\n\n" } else { "### 🤖 Cursor\n\n" });
        if let Some(th) = &b.thinking {
            s.push_str("<details><summary>💭 思考过程</summary>\n\n");
            s.push_str(&th.text);
            s.push_str("\n\n</details>\n\n");
        }
        if !b.text.is_empty() { s.push_str(&b.text); s.push_str("\n\n"); }
        for tc in &b.tool_calls {
            s.push_str(&format!("**🔧 {}** `{}`\n\n", tc.name.clone().unwrap_or_default(), tc.status.clone().unwrap_or_default()));
            if !tc.args.is_empty() { s.push_str("```json\n"); s.push_str(&tc.args); s.push_str("\n```\n"); }
            if !tc.result.is_empty() { s.push_str("<details><summary>结果</summary>\n\n```\n"); s.push_str(&tc.result); s.push_str("\n```\n</details>\n"); }
            s.push('\n');
        }
        if let Some(e) = &b.error { s.push_str(&format!("> ⚠️ 错误: {e}\n\n")); }
    }

    // 写到下载目录
    let dir = dirs::download_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
    let fname = format!("cursor-conversation-{}.md", &cid[..cid.len().min(8)]);
    let dest = dir.join(fname);
    std::fs::write(&dest, s).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}
