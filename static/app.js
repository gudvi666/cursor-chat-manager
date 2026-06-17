"use strict";

// ---------------- 全局状态 ---------------- //
const state = {
  conversations: [],
  selected: new Set(),
  activeId: null,
  cursorRunning: true,
  sizeCacheReady: false,
};

// ---------------- 工具函数 ---------------- //
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

function fmtBytes(n) {
  if (n == null) return "-";
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(1) + " " + u[i];
}
function fmtDate(ms) {
  if (!ms) return "-";
  const d = typeof ms === "string" ? new Date(ms) : new Date(ms);
  if (isNaN(d)) return "-";
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toast(msg, kind) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + (kind || "");
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 4200);
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}

// ---------------- 轻量 Markdown 渲染器 ---------------- //
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderMarkdown(src) {
  if (!src) return "";
  const codeBlocks = [];
  // 1) 抽出围栏代码块（带语言标签 + 复制按钮）
  src = src.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    const idx = codeBlocks.length;
    const lng = (lang.trim() || "code");
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    codeBlocks.push(
      `<div class="code-wrap"><div class="code-head"><span class="code-lang">${escapeHtml(lng)}</span>` +
      `<button class="copy-btn" type="button">复制</button></div><pre><code>${escaped}</code></pre></div>`);
    return `\u0000CB${idx}\u0000`;
  });

  // 2) 抽出行内代码
  const inlineCodes = [];
  src = src.replace(/`([^`\n]+)`/g, (m, c) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code class="inline">${escapeHtml(c)}</code>`);
    return `\u0000IC${idx}\u0000`;
  });

  // 3) 转义其余文本
  src = escapeHtml(src);

  // 4) 行内: 链接 / 粗 / 斜 / 删除线
  const inline = (t) => t
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // 5) 块级: 逐行
  const lines = src.split("\n");
  let out = "";
  let i = 0;
  let listType = null; // 'ul' | 'ol'
  const closeList = () => { if (listType) { out += `</${listType}>`; listType = null; } };

  while (i < lines.length) {
    let line = lines[i];

    // 占位代码块独占一行
    const cbMatch = line.match(/^\u0000CB(\d+)\u0000$/);
    if (cbMatch) { closeList(); out += codeBlocks[+cbMatch[1]]; i++; continue; }

    // 空行
    if (/^\s*$/.test(line)) { closeList(); i++; continue; }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }

    // 表格 (表头 + 分隔行)
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]+$/.test(lines[i + 1])) {
      closeList();
      const splitRow = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const header = splitRow(line);
      i += 2;
      let tbl = "<table><thead><tr>" + header.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
        const cells = splitRow(lines[i]);
        tbl += "<tr>" + cells.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
        i++;
      }
      tbl += "</tbody></table>";
      out += tbl; continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      closeList();
      let q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(inline(lines[i].replace(/^>\s?/, ""))); i++; }
      out += `<blockquote>${q.join("<br>")}</blockquote>`; continue;
    }

    // 无序列表
    let m = line.match(/^\s*[-*+]\s+(.*)$/);
    if (m) {
      if (listType !== "ul") { closeList(); out += "<ul>"; listType = "ul"; }
      out += `<li>${inline(m[1])}</li>`; i++; continue;
    }
    // 有序列表
    m = line.match(/^\s*\d+\.\s+(.*)$/);
    if (m) {
      if (listType !== "ol") { closeList(); out += "<ol>"; listType = "ol"; }
      out += `<li>${inline(m[1])}</li>`; i++; continue;
    }

    // 段落 (合并连续普通行)
    closeList();
    let para = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) &&
           !/^\u0000CB\d+\u0000$/.test(lines[i]) &&
           !/^(#{1,6})\s/.test(lines[i]) && !/^>\s?/.test(lines[i]) &&
           !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    out += `<p>${para.map(inline).join("<br>")}</p>`;
  }
  closeList();

  // 6) 还原占位
  out = out.replace(/\u0000IC(\d+)\u0000/g, (m, idx) => inlineCodes[+idx]);
  out = out.replace(/\u0000CB(\d+)\u0000/g, (m, idx) => codeBlocks[+idx]);
  return out;
}

// ---------------- 顶栏信息 ---------------- //
async function loadInfo() {
  const info = await api("/api/info");
  state.cursorRunning = info.cursorRunning;
  state.sizeCacheReady = info.sizeCacheReady;
  $("#dbinfo").textContent =
    `库 ${fmtBytes(info.sizeBytes)} · WAL ${fmtBytes(info.walBytes)} · 模式 ${info.journalMode || "?"}`;
  $("#running-banner").classList.toggle("hidden", !info.cursorRunning);
  const dis = info.cursorRunning;
  $("#btn-vacuum").disabled = dis;
  $("#btn-delete").disabled = dis || state.selected.size === 0;
}

// ---------------- 对话列表 ---------------- //
async function loadConversations() {
  const data = await api("/api/conversations");
  state.conversations = data.conversations;
  state.sizeCacheReady = data.sizeCacheReady;
  renderList();
}

function currentFiltered() {
  const q = $("#search").value.trim().toLowerCase();
  const cf = $("#filter").value;
  let list = state.conversations.filter((c) => !q || (c.name || "").toLowerCase().includes(q));
  if (cf === "empty") list = list.filter((c) => (c.messageCount || 0) === 0);
  else if (cf === "nonempty") list = list.filter((c) => (c.messageCount || 0) > 0);
  const sort = $("#sort").value;
  list.sort((a, b) => {
    if (sort === "updated") return (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0);
    if (sort === "created") return (b.createdAt || 0) - (a.createdAt || 0);
    if (sort === "size") return (b.sizeBytes || 0) - (a.sizeBytes || 0);
    if (sort === "name") return (a.name || "").localeCompare(b.name || "");
    return 0;
  });
  return list;
}

function renderList() {
  const list = currentFiltered();
  $("#match-count").textContent = `显示 ${list.length} / ${state.conversations.length}`;
  const ul = $("#conv-list");
  ul.innerHTML = "";
  for (const c of list) {
    const li = el("li", "conv-item" + (c.id === state.activeId ? " active" : ""));
    li.dataset.id = c.id;

    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = state.selected.has(c.id);
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      if (cb.checked) state.selected.add(c.id); else state.selected.delete(c.id);
      updateSelCount();
    });

    const main = el("div", "conv-main");
    main.appendChild(el("div", "conv-name", escapeHtml(c.name || "(未命名)")));
    const meta = el("div", "conv-meta");
    meta.appendChild(el("span", null, fmtDate(c.lastUpdatedAt)));
    if (c.mode) meta.appendChild(el("span", "badge", escapeHtml(c.mode)));
    if (c.messageCount != null) meta.appendChild(el("span", "badge", c.messageCount + " 条"));
    if (c.sizeBytes != null) meta.appendChild(el("span", "badge", fmtBytes(c.sizeBytes)));
    main.appendChild(meta);

    li.appendChild(cb);
    li.appendChild(main);
    li.addEventListener("click", () => openConversation(c.id));
    ul.appendChild(li);
  }
  updateSelCount();
}

function updateSelCount() {
  $("#sel-count").textContent = `已选 ${state.selected.size}`;
  $("#btn-delete").disabled = state.cursorRunning || state.selected.size === 0;
}

// ---------------- 对话详情 ---------------- //
async function openConversation(id) {
  state.activeId = id;
  renderList();
  showView("conversation");
  $("#conv-header").innerHTML = "加载中…";
  $("#bubbles").innerHTML = "";
  let data;
  try {
    data = await api("/api/conversation?id=" + encodeURIComponent(id));
  } catch (e) {
    $("#conv-header").innerHTML = `<span class="err">加载失败: ${escapeHtml(e.message)}</span>`;
    return;
  }
  const m = data.meta || {};
  const nonEmpty = (data.bubbles || []).filter(isRenderable);
  const sub = [];
  if (m.model) sub.push(escapeHtml(m.model));
  if (m.mode) sub.push(escapeHtml(m.mode));
  sub.push(`${m.messageCount || 0} 条消息 (${nonEmpty.length} 条有内容)`);
  if (m.createdAt) sub.push("创建 " + fmtDate(m.createdAt));
  if (m.contextTokensUsed) sub.push(`tokens ${m.contextTokensUsed}/${m.contextTokenLimit || "?"}`);
  $("#conv-header").innerHTML =
    `<div class="conv-head-row"><h2>${escapeHtml(m.name || "(未命名)")}</h2>` +
    `<button id="btn-export" title="导出为 Markdown 文件">⬇ 导出 MD</button></div>` +
    `<div class="sub">${sub.map((s) => `<span>${s}</span>`).join("")}</div>`;
  $("#btn-export").addEventListener("click", () => {
    window.location.href = "/api/export?id=" + encodeURIComponent(id);
  });

  const box = $("#bubbles");
  const frag = document.createDocumentFragment();
  for (const b of nonEmpty) frag.appendChild(renderBubble(b));
  box.appendChild(frag);
}

function isRenderable(b) {
  if (b.bajie) {
    const z = b.bajie;
    if (z.kind === "reply") return !!z.content;
    if (z.kind === "send") return !!z.message;
    if (z.kind === "wait") return ["user", "inter", "other"].includes(z.receivedKind) && !!z.received;
    return false;
  }
  return b.text || (b.thinking && b.thinking.text) || (b.toolCalls && b.toolCalls.length) || b.error;
}

const AVATAR_GLYPH = { user: "你", cursor: "✦", recv: "@", send: "↗" };

function msgShell(kind, name, headExtra) {
  const row = el("div", "msg msg-" + kind);
  const av = el("div", "avatar av-" + kind, AVATAR_GLYPH[kind] || "?");
  const bodyWrap = el("div", "msg-body");
  const head = el("div", "msg-head", `<span class="msg-name">${escapeHtml(name)}</span>${headExtra || ""}`);
  const content = el("div", "msg-content");
  bodyWrap.appendChild(head);
  bodyWrap.appendChild(content);
  row.appendChild(av);
  row.appendChild(bodyWrap);
  return { row, content };
}

function addUserBubble(content, text) {
  const bub = el("div", "user-bubble");
  bub.appendChild(el("div", "md", renderMarkdown(text)));
  content.appendChild(bub);
}

function renderToolCard(tc) {
  const d = el("details", "block tool");
  const status = tc.status ? `<span class="tool-status ${escapeHtml(tc.status)}">${escapeHtml(tc.status)}</span>` : "";
  d.appendChild(el("summary", null, `<span class="tool-ico">⚙</span> <span class="tool-name">${escapeHtml(tc.name || "tool")}</span> ${status}`));
  const inner = el("div", "inner");
  if (tc.args) {
    inner.appendChild(el("div", "label", "参数"));
    inner.appendChild(el("pre", null, `<code>${escapeHtml(prettyJson(tc.args))}</code>`));
  }
  if (tc.result) {
    inner.appendChild(el("div", "label", "结果"));
    inner.appendChild(el("pre", null, `<code>${escapeHtml(prettyJson(tc.result))}</code>`));
  }
  d.appendChild(inner);
  return d;
}

function renderBajie(z) {
  if (z.kind === "reply") {
    const status = z.agentStatus ? `<span class="status-badge">${escapeHtml(z.agentStatus)}</span>` : "";
    const { row, content } = msgShell("cursor", "Cursor", status);
    content.appendChild(el("div", "md", renderMarkdown(z.content)));
    return row;
  }
  if (z.kind === "wait") {
    const isUser = z.receivedKind === "user";
    const kind = isUser ? "user" : "recv";
    const name = isUser ? "你" : (z.receivedKind === "inter" ? "其它 Agent" : "收到消息");
    const { row, content } = msgShell(kind, name, "");
    if (isUser) addUserBubble(content, z.received);
    else content.appendChild(el("div", "md", renderMarkdown(z.received)));
    if (z.suggestions && z.suggestions.length) {
      const chips = el("div", "chips");
      for (const s of z.suggestions) chips.appendChild(el("span", "chip", escapeHtml(s)));
      content.appendChild(chips);
    }
    return row;
  }
  const mt = z.messageType ? `<span class="status-badge">${escapeHtml(z.messageType)}</span>` : "";
  const { row, content } = msgShell("send", "发送给 " + (z.target || ""), mt);
  content.appendChild(el("div", "md", renderMarkdown(z.message || "")));
  return row;
}

function renderBubble(b) {
  if (b.bajie) return renderBajie(b.bajie);
  const isUser = b.role === "user";
  const { row, content } = msgShell(isUser ? "user" : "cursor", isUser ? "你" : "Cursor", "");

  if (b.thinking && b.thinking.text) {
    const dur = b.thinking.durationMs ? ` · ${(b.thinking.durationMs / 1000).toFixed(1)}s` : "";
    const d = el("details", "block thinking");
    d.appendChild(el("summary", null, "💭 思考过程" + dur));
    d.appendChild(el("div", "inner md", renderMarkdown(b.thinking.text)));
    content.appendChild(d);
  }
  if (b.text) {
    if (isUser) addUserBubble(content, b.text);
    else content.appendChild(el("div", "md", renderMarkdown(b.text)));
  }
  for (const tc of b.toolCalls || []) content.appendChild(renderToolCard(tc));
  if (b.error) content.appendChild(el("div", "err", "错误: " + escapeHtml(b.error)));
  return row;
}

function prettyJson(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

// ---------------- 操作 ---------------- //
async function doScan() {
  const btn = $("#btn-scan");
  btn.disabled = true; btn.textContent = "扫描中…";
  try {
    await api("/api/scan-sizes", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await loadConversations();
    toast("体积扫描完成", "ok");
  } catch (e) { toast("扫描失败: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "扫描体积"; }
}

async function doBackup() {
  const btn = $("#btn-backup");
  btn.disabled = true; btn.textContent = "备份中…";
  try {
    const r = await api("/api/backup", { method: "POST" });
    toast("已备份: " + r.backupPath, "ok");
  } catch (e) { toast("备份失败: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "备份整库"; }
}

async function doVacuum() {
  if (!confirm("VACUUM 会重建数据库以回收空间，需要约等于库大小的临时磁盘空间，且耗时较久。继续？")) return;
  const btn = $("#btn-vacuum");
  btn.disabled = true; btn.textContent = "回收中…";
  try {
    const r = await api("/api/vacuum", { method: "POST" });
    toast(`VACUUM 完成，回收 ${fmtBytes(r.freedBytes)}`, "ok");
    await loadInfo();
  } catch (e) { toast("VACUUM 失败: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "VACUUM 回收"; }
}

async function doDelete() {
  const ids = [...state.selected];
  if (!ids.length) return;
  const withVacuum = $("#auto-vacuum").checked;
  const extra = withVacuum ? "，并在删除后 VACUUM 回收空间（较慢）" : "";
  if (!confirm(`将删除 ${ids.length} 个对话及其全部消息/快照，并自动整库备份${extra}。此操作不可逆，确认继续？`)) return;
  const btn = $("#btn-delete");
  btn.disabled = true; btn.textContent = withVacuum ? "删除并回收中…" : "删除中…";
  try {
    const r = await api("/api/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, backup: true, vacuum: withVacuum }),
    });
    let msg = `已删除 ${r.deletedConversations} 个对话 / ${r.deletedKeys} 个键`;
    if (r.vacuum) msg += `，VACUUM 回收 ${fmtBytes(r.vacuum.freedBytes)}`;
    else if (r.vacuumError) msg += `（VACUUM 失败: ${r.vacuumError}）`;
    msg += `，备份于 ${r.backupPath}`;
    toast(msg, "ok");
    state.selected.clear();
    if (state.activeId && ids.includes(state.activeId)) {
      state.activeId = null;
      $("#conversation").classList.add("hidden");
      $("#empty").classList.remove("hidden");
    }
    await loadConversations();
    await loadInfo();
  } catch (e) { toast("删除失败: " + e.message, "error"); }
  finally { btn.textContent = "删除所选"; updateSelCount(); }
}

// ---------------- 视图切换 ---------------- //
function showView(name) {
  for (const v of ["empty", "conversation", "search-results", "stats", "cleanup"]) {
    document.getElementById(v).classList.toggle("hidden", v !== name);
  }
}

// ---------------- 全文搜索 ---------------- //
function highlight(escapedText, q) {
  const eq = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escapedText.replace(new RegExp(eq, "gi"), (m) => `<mark>${m}</mark>`);
}

async function doSearch() {
  const q = $("#global-search").value.trim();
  if (!q) return;
  const box = $("#search-results");
  box.innerHTML = `<h2>搜索中… “${escapeHtml(q)}”</h2>`;
  showView("search-results");
  let d;
  try { d = await api("/api/search?q=" + encodeURIComponent(q)); }
  catch (e) { box.innerHTML = `<div class="err">搜索失败: ${escapeHtml(e.message)}</div>`; return; }
  let html = `<h2>“${escapeHtml(q)}” — 命中 ${d.matchCount} 条消息 / ${d.conversationCount} 个对话${d.truncated ? " (结果已截断)" : ""}</h2>`;
  if (!d.results.length) html += `<div class="muted">无匹配</div>`;
  for (const r of d.results) {
    html += `<div class="search-item" data-id="${r.id}"><div class="search-name">${escapeHtml(r.name)} <span class="badge">${r.matches} 命中</span></div>`;
    for (const s of r.snippets) html += `<div class="snippet">${highlight(escapeHtml(s), q)}</div>`;
    html += `</div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll(".search-item").forEach((it) =>
    it.addEventListener("click", () => openConversation(it.dataset.id)));
}

// ---------------- 统计仪表盘 ---------------- //
function barChart(pairs, asBytes) {
  if (!pairs || !pairs.length) return `<div class="muted">无数据</div>`;
  const max = Math.max(...pairs.map((p) => p[1])) || 1;
  return `<div class="bars">` + pairs.map(([label, val]) =>
    `<div class="bar-row"><div class="bar-label" title="${escapeHtml(String(label))}">${escapeHtml(String(label))}</div>` +
    `<div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, val / max * 100)}%"></div></div>` +
    `<div class="bar-val">${asBytes ? fmtBytes(val) : val.toLocaleString()}</div></div>`).join("") + `</div>`;
}

async function doStats() {
  const box = $("#stats");
  box.innerHTML = "<h2>统计加载中…</h2>";
  showView("stats");
  let d;
  try { d = await api("/api/stats"); }
  catch (e) { box.innerHTML = `<div class="err">${escapeHtml(e.message)}</div>`; return; }
  let html = `<h2>统计总览</h2><div class="stat-cards">
    <div class="card"><div class="num">${d.totalConversations.toLocaleString()}</div><div>对话(含空壳)</div></div>
    <div class="card"><div class="num">${(d.conversationsWithBody || 0).toLocaleString()}</div><div>有正文对话</div></div>
    <div class="card"><div class="num">${d.totalMessages.toLocaleString()}</div><div>消息气泡</div></div>
  </div>`;
  html += `<h3>按模型</h3>` + barChart(d.byModel);
  html += `<h3>按天 (近 30 天有活动)</h3>` + barChart(d.byDay);
  html += `<h3>磁盘占用</h3><button id="btn-prefix">加载空间分布(较慢)</button><div id="prefix-box"></div>`;
  box.innerHTML = html;
  $("#btn-prefix").addEventListener("click", async () => {
    const pb = $("#prefix-box"); pb.innerHTML = "扫描中…(可能数十秒)";
    try {
      const p = await api("/api/prefix-stats");
      pb.innerHTML = barChart(p.prefixes.map((x) => [`${x.pfx} (${x.n})`, x.bytes]), true);
    } catch (e) { pb.innerHTML = `<div class="err">${escapeHtml(e.message)}</div>`; }
  });
}

// ---------------- agentKv 缓存清理 ---------------- //
function doCleanup() {
  const box = $("#cleanup");
  showView("cleanup");
  box.innerHTML = `<h2>清理 agentKv 缓存</h2>
    <p class="muted">agentKv 是内容寻址的工具结果缓存。删除或中止对话后，其缓存块会残留成为“孤儿”。此处扫描出未被任何现存对话引用的孤儿块并安全清理（删前自动备份、删后 VACUUM）。</p>
    <button id="btn-akv-scan">扫描孤儿缓存 (约 30 秒)</button>
    <div id="akv-result"></div>`;
  $("#btn-akv-scan").addEventListener("click", akvScan);
}

async function akvScan() {
  const r = $("#akv-result");
  r.innerHTML = "扫描中…(约 30 秒，请稍候)";
  try {
    const d = await api("/api/agentkv-scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    r.innerHTML = `<div class="card-inline">共 ${d.totalBlobs.toLocaleString()} 块 / ${fmtBytes(d.totalBytes)}，其中 <strong>孤儿 ${d.orphanCount.toLocaleString()} 块 / ${fmtBytes(d.orphanBytes)}</strong> 可回收。</div>`;
    if (d.orphanCount > 0) {
      const btn = el("button", "danger");
      btn.textContent = `删除 ${d.orphanCount.toLocaleString()} 个孤儿并回收`;
      btn.disabled = state.cursorRunning;
      if (state.cursorRunning) btn.title = "Cursor 运行中，已禁用；请先退出 Cursor";
      btn.addEventListener("click", () => akvPurge(d));
      r.appendChild(btn);
    }
  } catch (e) { r.innerHTML = `<div class="err">${escapeHtml(e.message)}</div>`; }
}

async function akvPurge(scan) {
  if (!confirm(`将删除 ${scan.orphanCount} 个孤儿 agentKv 缓存块（约 ${fmtBytes(scan.orphanBytes)}），删前自动整库备份、删后 VACUUM 回收。此操作不可逆，确认继续？`)) return;
  const r = $("#akv-result");
  r.innerHTML = "删除并回收中…(备份 + VACUUM 可能较久，请耐心等待)";
  try {
    const d = await api("/api/agentkv-purge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ backup: true, vacuum: true }) });
    let msg = `已删除 ${d.deletedBlobs.toLocaleString()} 块`;
    if (d.vacuum) msg += `，VACUUM 回收 ${fmtBytes(d.vacuum.freedBytes)}`;
    if (d.backupPath) msg += `，备份于 ${d.backupPath}`;
    r.innerHTML = `<div class="card-inline ok">${escapeHtml(msg)}</div>`;
    toast("缓存清理完成", "ok");
    await loadInfo();
  } catch (e) { r.innerHTML = `<div class="err">${escapeHtml(e.message)}</div>`; }
}

// ---------------- 事件绑定 ---------------- //
function bind() {
  $("#search").addEventListener("input", renderList);
  $("#sort").addEventListener("change", renderList);
  $("#filter").addEventListener("change", async () => {
    // 识别空对话需要每对话消息数, 未扫描则先自动扫描
    if ($("#filter").value !== "all" && !state.sizeCacheReady) {
      toast("正在扫描以识别空对话…");
      await doScan();
    }
    renderList();
  });
  $("#select-all").addEventListener("change", (e) => {
    const list = currentFiltered();
    if (e.target.checked) list.forEach((c) => state.selected.add(c.id));
    else list.forEach((c) => state.selected.delete(c.id));
    renderList();
  });
  $("#btn-scan").addEventListener("click", doScan);
  $("#btn-backup").addEventListener("click", doBackup);
  $("#btn-vacuum").addEventListener("click", doVacuum);
  $("#btn-delete").addEventListener("click", doDelete);
  $("#btn-stats").addEventListener("click", doStats);
  $("#btn-cleanup").addEventListener("click", doCleanup);
  $("#global-search").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".copy-btn");
    if (!b) return;
    const code = b.closest(".code-wrap").querySelector("pre code");
    navigator.clipboard.writeText(code.textContent).then(() => {
      b.textContent = "已复制"; b.classList.add("copied");
      setTimeout(() => { b.textContent = "复制"; b.classList.remove("copied"); }, 1200);
    });
  });
}

(async function init() {
  bind();
  try {
    await loadInfo();
    await loadConversations();
  } catch (e) {
    toast("初始化失败: " + e.message, "error");
  }
})();
