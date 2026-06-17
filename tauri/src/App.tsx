import { useEffect, useMemo, useState, useCallback } from "react";
import {
  ConfigProvider, App as AntApp, Layout, Button, Input, Select, Checkbox, Tag, Card, Statistic,
  Row, Col, Collapse, Empty, Tooltip, Typography, Space, Spin, theme,
} from "antd";
import {
  BarChartOutlined, ClearOutlined, SaveOutlined, ThunderboltOutlined, DeleteOutlined,
  DownloadOutlined, SearchOutlined, FolderOpenOutlined, ReloadOutlined,
} from "@ant-design/icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  api, fmtBytes, fmtDate,
  type DbInfo, type ConvSummary, type ConversationData, type Bubble, type Bajie,
  type SearchResult, type Stats, type PrefixStat, type OrphanScan,
} from "./api";
import { renderMarkdown } from "./markdown";

const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;

type View = "empty" | "conversation" | "search" | "stats" | "cleanup";
const GLYPH: Record<string, string> = { user: "你", cursor: "✦", recv: "@", send: "↗" };

function Md({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

function Msg({ kind, name, badge, children }: { kind: string; name: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={"msg msg-" + kind}>
      <div className={"avatar av-" + kind}>{GLYPH[kind] || "?"}</div>
      <div className="msg-body">
        <div className="msg-head"><span className="msg-name">{name}</span>{badge}</div>
        <div className="msg-content">{children}</div>
      </div>
    </div>
  );
}

const pretty = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };

function isRenderable(b: Bubble): boolean {
  if (b.bajie) {
    const z = b.bajie;
    if (z.kind === "reply") return !!z.content;
    if (z.kind === "send") return !!z.message;
    if (z.kind === "wait") return ["user", "inter", "other"].includes(z.receivedKind || "") && !!z.received;
    return false;
  }
  return !!(b.text || b.thinking?.text || b.toolCalls.length || b.error);
}

function ExtrasCollapse({ b }: { b: Bubble }) {
  const items: any[] = [];
  if (b.thinking?.text)
    items.push({
      key: "think",
      label: <span style={{ color: "#e3c987" }}>💭 思考过程{b.thinking.durationMs ? ` · ${(b.thinking.durationMs / 1000).toFixed(1)}s` : ""}</span>,
      children: <Md text={b.thinking.text} />,
    });
  b.toolCalls.forEach((tc, i) =>
    items.push({
      key: "tool" + i,
      label: <span style={{ color: "#8fd9b3" }}>⚙ {tc.name || "tool"} {tc.status && <Tag color={tc.status === "completed" ? "green" : "default"} bordered={false}>{tc.status}</Tag>}</span>,
      children: (
        <div>
          {tc.args && (<><div className="label">参数</div><pre className="codepre">{pretty(tc.args)}</pre></>)}
          {tc.result && (<><div className="label">结果</div><pre className="codepre">{pretty(tc.result)}</pre></>)}
        </div>
      ),
    }));
  if (!items.length) return null;
  return <Collapse className="extras" size="small" items={items} />;
}

function BajieMsg({ z }: { z: Bajie }) {
  if (z.kind === "reply")
    return <Msg kind="cursor" name="Cursor" badge={z.agentStatus && <Tag color="geekblue" bordered={false}>{z.agentStatus}</Tag>}><Md text={z.content || ""} /></Msg>;
  if (z.kind === "wait") {
    const isUser = z.receivedKind === "user";
    const name = isUser ? "你" : z.receivedKind === "inter" ? "其它 Agent" : "收到消息";
    return (
      <Msg kind={isUser ? "user" : "recv"} name={name}>
        {isUser ? <div className="user-bubble"><Md text={z.received || ""} /></div> : <Md text={z.received || ""} />}
        {z.suggestions && z.suggestions.length > 0 && (
          <Space size={[6, 6]} wrap style={{ marginTop: 8 }}>
            {z.suggestions.map((s, i) => <Tag key={i} bordered>{s}</Tag>)}
          </Space>
        )}
      </Msg>
    );
  }
  return <Msg kind="send" name={"发送给 " + (z.target || "")} badge={z.messageType && <Tag bordered={false}>{z.messageType}</Tag>}><Md text={z.message || ""} /></Msg>;
}

function BubbleMsg({ b }: { b: Bubble }) {
  if (b.bajie) return <BajieMsg z={b.bajie} />;
  const isUser = b.role === "user";
  return (
    <Msg kind={isUser ? "user" : "cursor"} name={isUser ? "你" : "Cursor"}>
      <ExtrasCollapse b={b} />
      {b.text && (isUser ? <div className="user-bubble"><Md text={b.text} /></div> : <Md text={b.text} />)}
      {b.error && <Text type="danger">错误: {b.error}</Text>}
    </Msg>
  );
}

function Bars({ pairs, bytes }: { pairs: [string, number][]; bytes?: boolean }) {
  const max = Math.max(...pairs.map((p) => p[1]), 1);
  if (!pairs.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无数据" />;
  return (
    <div className="bars">
      {pairs.map(([label, val]) => (
        <div className="bar-row" key={label}>
          <div className="bar-label" title={label}>{label}</div>
          <div className="bar-track"><div className="bar-fill" style={{ width: Math.max(2, (val / max) * 100) + "%" }} /></div>
          <div className="bar-val">{bytes ? fmtBytes(val) : val.toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

const DONUT_COLORS = ["#7c93ff", "#3ecf8e", "#f5c451", "#f26d6d", "#9b8cff", "#4ec9e0", "#e08f5b", "#b06ad6", "#6a7080"];

function Donut({ data }: { data: PrefixStat[] }) {
  const items = [...data].sort((a, b) => b.bytes - a.bytes);
  const total = items.reduce((s, d) => s + d.bytes, 0) || 1;
  if (!items.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无数据" />;
  const R = 60, sw = 28, C = 2 * Math.PI * R;
  let offset = 0;
  const segs = items.map((d, i) => {
    const frac = d.bytes / total;
    const seg = { ...d, frac, len: frac * C, off: offset, color: DONUT_COLORS[i % DONUT_COLORS.length] };
    offset += frac * C;
    return seg;
  });
  return (
    <div className="donut-wrap">
      <svg className="donut" viewBox="0 0 160 160">
        <circle cx="80" cy="80" r={R} fill="none" stroke="rgba(255,255,255,.06)" strokeWidth={sw} />
        {segs.map((s, i) => (
          <circle key={i} cx="80" cy="80" r={R} fill="none" stroke={s.color} strokeWidth={sw}
            strokeDasharray={`${s.len} ${C - s.len}`} strokeDashoffset={-s.off} transform="rotate(-90 80 80)" />
        ))}
        <text x="80" y="75" className="donut-total">{fmtBytes(total)}</text>
        <text x="80" y="93" className="donut-sub">总占用</text>
      </svg>
      <div className="donut-legend">
        {segs.map((s, i) => (
          <div className="legend-row" key={i}>
            <span className="legend-dot" style={{ background: s.color }} />
            <span className="legend-name" title={s.pfx}>{s.pfx} ({s.n})</span>
            <span className="legend-pct">{(s.frac * 100).toFixed(1)}%</span>
            <span className="legend-size">{fmtBytes(s.bytes)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Main() {
  const { message, modal } = AntApp.useApp();
  const [info, setInfo] = useState<DbInfo | null>(null);
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [sizeReady, setSizeReady] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conv, setConv] = useState<ConversationData | null>(null);
  const [convLoading, setConvLoading] = useState(false);
  const [view, setView] = useState<View>("empty");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("updated");
  const [filter, setFilter] = useState("all");
  const [globalQ, setGlobalQ] = useState("");
  const [searchRes, setSearchRes] = useState<SearchResult | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [prefixes, setPrefixes] = useState<PrefixStat[] | null>(null);
  const [orphan, setOrphan] = useState<OrphanScan | null>(null);
  const [autoVacuum, setAutoVacuum] = useState(true);
  const [busy, setBusy] = useState<string>("");

  const loadInfo = useCallback(async () => { try { setInfo(await api.info()); } catch (e: any) { message.error(String(e)); } }, [message]);
  const loadConvs = useCallback(async () => {
    const d = await api.conversations();
    setConvs(d.conversations); setSizeReady(d.sizeCacheReady);
  }, []);
  useEffect(() => { loadInfo(); loadConvs().catch((e) => message.error(String(e))); }, [loadInfo, loadConvs, message]);

  const cursorRunning = info?.cursorRunning ?? true;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = convs.filter((c) => !q || (c.name || "").toLowerCase().includes(q));
    if (filter === "empty") list = list.filter((c) => (c.messageCount || 0) === 0);
    else if (filter === "nonempty") list = list.filter((c) => (c.messageCount || 0) > 0);
    else if (filter === "archived") list = list.filter((c) => c.archived);
    else if (filter === "unarchived") list = list.filter((c) => !c.archived);
    return [...list].sort((a, b) => {
      if (sort === "updated") return (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0);
      if (sort === "created") return (b.createdAt || 0) - (a.createdAt || 0);
      if (sort === "size") return (b.sizeBytes || 0) - (a.sizeBytes || 0);
      if (sort === "name") return (a.name || "").localeCompare(b.name || "");
      return 0;
    });
  }, [convs, search, sort, filter]);

  const openConv = async (id: string) => {
    setActiveId(id); setView("conversation"); setConv(null); setConvLoading(true);
    try { setConv(await api.conversation(id)); } catch (e: any) { message.error("加载失败: " + e); } finally { setConvLoading(false); }
  };

  const run = async (key: string, fn: () => Promise<void>) => { setBusy(key); try { await fn(); } finally { setBusy(""); } };
  const doScan = () => run("scan", async () => { try { await api.scanSizes(); await loadConvs(); message.success("体积扫描完成"); } catch (e: any) { message.error("扫描失败: " + e); } });
  const doRefresh = () => run("refresh", async () => { try { await Promise.all([loadInfo(), loadConvs()]); message.success("已刷新"); } catch (e: any) { message.error("刷新失败: " + e); } });
  const onFilter = async (v: string) => { setFilter(v); if ((v === "empty" || v === "nonempty") && !sizeReady) { message.info("正在扫描以识别空对话…"); await doScan(); } };
  const doBackup = () => run("backup", async () => { try { message.success("已备份: " + (await api.backup())); } catch (e: any) { message.error("备份失败: " + e); } });
  const doVacuum = () => modal.confirm({
    title: "VACUUM 回收空间", content: "会重建数据库回收空间，需约等于库大小的临时磁盘，耗时较久。继续？",
    onOk: () => run("vacuum", async () => { try { const r = await api.vacuum(); message.success(`VACUUM 完成，回收 ${fmtBytes(r.freedBytes)}`); await loadInfo(); } catch (e: any) { message.error("VACUUM 失败: " + e); } }),
  });
  const doDelete = () => {
    const ids = [...selected];
    if (!ids.length) return;
    modal.confirm({
      title: `删除 ${ids.length} 个对话`, content: `将删除其全部消息/快照并自动备份${autoVacuum ? "，删后 VACUUM 回收" : ""}。此操作不可逆。`,
      okButtonProps: { danger: true }, okText: "删除",
      onOk: () => run("delete", async () => {
        try {
          const r = await api.deleteConversations(ids, true, autoVacuum);
          let m = `已删除 ${r.deletedConversations} 个对话 / ${r.deletedKeys} 键`;
          if (r.vacuum) m += `，回收 ${fmtBytes(r.vacuum.freedBytes)}`;
          message.success(m); setSelected(new Set());
          if (activeId && ids.includes(activeId)) { setActiveId(null); setView("empty"); }
          await loadConvs(); await loadInfo();
        } catch (e: any) { message.error("删除失败: " + e); }
      }),
    });
  };
  const doDeleteArchived = () => {
    const ids = convs.filter((c) => c.archived).map((c) => c.id);
    if (!ids.length) { message.info("没有归档会话"); return; }
    modal.confirm({
      title: `删除全部 ${ids.length} 个归档会话`,
      content: `将删除这 ${ids.length} 个已归档会话及其全部消息/快照，删前自动备份${autoVacuum ? "，删后 VACUUM 回收" : ""}。此操作不可逆。`,
      okButtonProps: { danger: true }, okText: `删除 ${ids.length} 个`,
      onOk: () => run("delarch", async () => {
        try {
          const r = await api.deleteConversations(ids, true, autoVacuum);
          let m = `已删除 ${r.deletedConversations} 个归档会话 / ${r.deletedKeys} 键`;
          if (r.vacuum) m += `，回收 ${fmtBytes(r.vacuum.freedBytes)}`;
          message.success(m); setSelected(new Set());
          if (activeId && ids.includes(activeId)) { setActiveId(null); setView("empty"); }
          await loadConvs(); await loadInfo();
        } catch (e: any) { message.error("删除失败: " + e); }
      }),
    });
  };
  const doSearch = async () => {
    const q = globalQ.trim(); if (!q) return;
    setView("search"); setSearchRes(null);
    try { setSearchRes(await api.search(q)); } catch (e: any) { message.error("搜索失败: " + e); }
  };
  const loadPrefixes = () => run("prefix", async () => { try { setPrefixes(await api.prefixStats()); } catch (e: any) { message.error(String(e)); } });
  const doStats = () => {
    setView("stats"); setStats(null); setPrefixes(null);
    (async () => { try { setStats(await api.stats()); } catch (e: any) { message.error(String(e)); } })();
    loadPrefixes(); // 进入统计页即自动分析磁盘占用，无需手动点按钮
  };
  const akvScan = () => run("akv", async () => { try { setOrphan(await api.agentkvScan()); } catch (e: any) { message.error(String(e)); } });
  const akvPurge = () => {
    if (!orphan) return;
    modal.confirm({
      title: "清理孤儿缓存", content: `将删除 ${orphan.orphanCount} 个孤儿缓存（约 ${fmtBytes(orphan.orphanBytes)}），删前备份、删后 VACUUM。`,
      okButtonProps: { danger: true }, okText: "删除",
      onOk: () => run("akv", async () => { try { const r = await api.agentkvPurge(true, true); let m = `已删除 ${r.deletedBlobs} 块`; if (r.vacuum) m += `，回收 ${fmtBytes(r.vacuum.freedBytes)}`; message.success(m); setOrphan(null); await loadInfo(); } catch (e: any) { message.error(String(e)); } }),
    });
  };
  const doExport = async (id: string) => { try { message.success("已导出到 " + (await api.exportMd(id))); } catch (e: any) { message.error("导出失败: " + e); } };
  const pickDb = async () => {
    try {
      const sel = await openDialog({ multiple: false, title: "选择 Cursor 数据库 (state.vscdb)", filters: [{ name: "Cursor DB", extensions: ["vscdb"] }] });
      if (typeof sel === "string") {
        const ni = await api.setDbPath(sel);
        setInfo(ni);
        setActiveId(null); setConv(null); setView("empty");
        await loadConvs();
        message.success(ni.exists ? "已切换数据库" : "该文件无法读取");
      }
    } catch (e: any) { message.error("选择失败: " + e); }
  };

  const onContentClick = (e: React.MouseEvent) => {
    const t = (e.target as HTMLElement).closest(".copy-btn") as HTMLElement | null;
    if (!t) return;
    const code = t.closest(".code-wrap")?.querySelector("pre code");
    if (code) navigator.clipboard.writeText(code.textContent || "").then(() => {
      t.textContent = "已复制"; setTimeout(() => { t.textContent = "复制"; }, 1200);
    });
  };

  const toggleSel = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allChecked = filtered.length > 0 && filtered.every((c) => selected.has(c.id));
  const archivedCount = useMemo(() => convs.filter((c) => c.archived).length, [convs]);
  const selectAll = (checked: boolean) => setSelected((s) => { const n = new Set(s); filtered.forEach((c) => checked ? n.add(c.id) : n.delete(c.id)); return n; });
  const renderable = conv ? conv.bubbles.filter(isRenderable) : [];

  return (
    <Layout style={{ height: "100vh", overflow: "hidden" }}>
      <Header className="topbar">
        <div className="brand">Cursor Chat Manager</div>
        <Tooltip title={info?.path || ""}>
          <Text type="secondary" className="dbinfo">{info ? (info.exists ? `库 ${fmtBytes(info.sizeBytes)} · WAL ${fmtBytes(info.walBytes)} · ${info.journalMode || "?"}` : "⚠ 未找到数据库") : "加载中…"}</Text>
        </Tooltip>
        <Input prefix={<SearchOutlined />} placeholder="全文搜索消息内容…(回车)" allowClear style={{ width: 280 }}
          value={globalQ} onChange={(e) => setGlobalQ(e.target.value)} onPressEnter={doSearch} />
        <Space>
          <Button icon={<ReloadOutlined />} loading={busy === "refresh"} onClick={doRefresh}>刷新</Button>
          <Button icon={<FolderOpenOutlined />} onClick={pickDb}>选择库</Button>
          <Button icon={<BarChartOutlined />} onClick={doStats}>统计</Button>
          <Button icon={<ClearOutlined />} onClick={() => setView("cleanup")}>清理缓存</Button>
          <Button icon={<ThunderboltOutlined />} loading={busy === "scan"} onClick={doScan}>扫描体积</Button>
          <Button icon={<SaveOutlined />} loading={busy === "backup"} onClick={doBackup}>备份</Button>
          <Button danger loading={busy === "vacuum"} disabled={cursorRunning} onClick={doVacuum}>VACUUM</Button>
        </Space>
      </Header>

      {cursorRunning && (
        <div className="banner">Cursor 正在运行 —— 当前为<b>只读模式</b>，删除与回收已禁用。要清理请先完全退出 Cursor。</div>
      )}

      <Layout className="app-body">
        <Sider width={360} className="sider" theme="dark">
          <div className="sider-tools">
            <Input.Search placeholder="搜索对话标题…" allowClear value={search} onChange={(e) => setSearch(e.target.value)} />
            <Space.Compact block style={{ marginTop: 8 }}>
              <Select style={{ flex: 1 }} value={sort} onChange={setSort} options={[
                { value: "updated", label: "按最近更新" }, { value: "created", label: "按创建时间" },
                { value: "size", label: "按体积(需扫描)" }, { value: "name", label: "按标题" },
              ]} />
              <Select style={{ flex: 1 }} value={filter} onChange={onFilter} options={[
                { value: "all", label: "内容: 全部" }, { value: "empty", label: "仅空对话" }, { value: "nonempty", label: "仅有内容" },
                { value: "archived", label: "仅归档" }, { value: "unarchived", label: "仅未归档" },
              ]} />
            </Space.Compact>
            <div className="bulkbar">
              <Checkbox checked={allChecked} indeterminate={!allChecked && selected.size > 0} onChange={(e) => selectAll(e.target.checked)}>全选</Checkbox>
              <Text type="secondary" style={{ flex: 1, fontSize: 12 }}>已选 {selected.size} · 共 {filtered.length}</Text>
              <Tooltip title="删除后自动 VACUUM"><Checkbox checked={autoVacuum} onChange={(e) => setAutoVacuum(e.target.checked)}>删后回收</Checkbox></Tooltip>
              <Button danger size="small" icon={<DeleteOutlined />} loading={busy === "delete"} disabled={cursorRunning || selected.size === 0} onClick={doDelete}>删除</Button>
              <Tooltip title={cursorRunning ? "Cursor 运行中，删除已禁用" : `删除全部 ${archivedCount} 个归档会话`}>
                <Button danger size="small" loading={busy === "delarch"} disabled={cursorRunning || archivedCount === 0} onClick={doDeleteArchived}>清归档{archivedCount ? ` ${archivedCount}` : ""}</Button>
              </Tooltip>
            </div>
          </div>
          <div className="conv-list">
            {filtered.map((c) => (
              <div key={c.id} className={"conv-item" + (c.id === activeId ? " active" : "")} onClick={() => openConv(c.id)}>
                <Checkbox checked={selected.has(c.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleSel(c.id)} />
                <div className="conv-main">
                  <div className="conv-name" title={c.name || "(未命名)"}>{c.name || "(未命名)"}</div>
                  <div className="conv-meta">
                    <span>{fmtDate(c.lastUpdatedAt)}</span>
                    {c.mode && <Tag bordered={false}>{c.mode}</Tag>}
                    {c.messageCount != null && <Tag bordered={false} color={c.messageCount === 0 ? "default" : "blue"}>{c.messageCount} 条</Tag>}
                    {c.sizeBytes != null && <Tag bordered={false}>{fmtBytes(c.sizeBytes)}</Tag>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Sider>

        <Content className="content" onClick={onContentClick}>
          {info && !info.exists && (
            <div className="center">
              <Empty description={<span>未找到 Cursor 数据库<br /><Text type="secondary" style={{ fontSize: 12 }}>{info.path}</Text></span>}>
                <Button type="primary" icon={<FolderOpenOutlined />} onClick={pickDb}>选择 state.vscdb</Button>
              </Empty>
            </div>
          )}
          {(!info || info.exists) && view === "empty" && <div className="center"><Empty description="从左侧选择一个对话查看" /></div>}

          {(!info || info.exists) && view === "conversation" && (
            <div className="conv-view">
              <div className="conv-header">
                <div className="conv-head-row">
                  <Title level={4} style={{ margin: 0, flex: 1 }}>{conv?.meta.name || (convLoading ? "加载中…" : "(未命名)")}</Title>
                  {conv && <Button icon={<DownloadOutlined />} onClick={() => doExport(conv.meta.id)}>导出 MD</Button>}
                </div>
                {conv && (
                  <Text className="conv-id" copyable={{ text: conv.meta.id }}>ID: {conv.meta.id}</Text>
                )}
                {conv && (
                  <Space size={[6, 4]} wrap style={{ marginTop: 6 }}>
                    {conv.meta.model && <Tag bordered={false} color="geekblue">{conv.meta.model}</Tag>}
                    {conv.meta.mode && <Tag bordered={false}>{conv.meta.mode}</Tag>}
                    <Tag bordered={false}>{conv.meta.messageCount} 条 ({renderable.length} 有内容)</Tag>
                    {conv.meta.createdAt && <Text type="secondary" style={{ fontSize: 12 }}>创建 {fmtDate(conv.meta.createdAt)}</Text>}
                    {conv.meta.contextTokensUsed && <Text type="secondary" style={{ fontSize: 12 }}>tokens {conv.meta.contextTokensUsed}/{conv.meta.contextTokenLimit || "?"}</Text>}
                  </Space>
                )}
              </div>
              <div className="bubbles">
                {convLoading ? <div className="center"><Spin /></div> : renderable.map((b, i) => <BubbleMsg b={b} key={i} />)}
              </div>
            </div>
          )}

          {(!info || info.exists) && view === "search" && (
            <div className="panel">
              {!searchRes ? <div className="center"><Spin tip="搜索中…"><div style={{ padding: 40 }} /></Spin></div> : (
                <>
                  <Title level={4}>“{searchRes.query}” — 命中 {searchRes.matchCount} 条 / {searchRes.conversationCount} 个对话{searchRes.truncated ? " (已截断)" : ""}</Title>
                  {!searchRes.results.length && <Empty description="无匹配" />}
                  {searchRes.results.map((r) => (
                    <Card key={r.id} size="small" hoverable style={{ marginBottom: 10 }} onClick={() => openConv(r.id)}
                      title={<Space>{r.name}<Tag color="blue" bordered={false}>{r.matches} 命中</Tag></Space>}>
                      {r.snippets.map((s, i) => <div className="snippet" key={i}>{s}</div>)}
                    </Card>
                  ))}
                </>
              )}
            </div>
          )}

          {(!info || info.exists) && view === "stats" && (
            <div className="panel stats-panel">
              {!stats ? <div className="center"><Spin tip="统计加载中…"><div style={{ padding: 40 }} /></Spin></div> : (
                <Row gutter={24}>
                  <Col xs={24} lg={13}>
                    <Title level={4}>统计总览</Title>
                    <Row gutter={16}>
                      <Col span={8}><Card><Statistic title="对话(含空壳)" value={stats.totalConversations} /></Card></Col>
                      <Col span={8}><Card><Statistic title="有正文对话" value={stats.conversationsWithBody} /></Card></Col>
                      <Col span={8}><Card><Statistic title="消息气泡" value={stats.totalMessages} /></Card></Col>
                    </Row>
                    <Title level={5} style={{ marginTop: 20 }}>按模型</Title><Bars pairs={stats.byModel} />
                    <Title level={5} style={{ marginTop: 20 }}>按天 (近 30 天有活动)</Title><Bars pairs={stats.byDay} />
                  </Col>
                  <Col xs={24} lg={11}>
                    <Title level={4}>磁盘占用</Title>
                    {!prefixes ? <div className="center" style={{ height: 220 }}><Spin tip="分析磁盘占用…"><div style={{ padding: 30 }} /></Spin></div> : <Donut data={prefixes} />}
                  </Col>
                </Row>
              )}
            </div>
          )}

          {(!info || info.exists) && view === "cleanup" && (
            <div className="panel">
              <Title level={4}>清理 agentKv 缓存</Title>
              <Text type="secondary">agentKv 是内容寻址的工具结果缓存。删除/中止对话后其缓存块会残留成“孤儿”。此处扫描未被任何现存对话引用的孤儿块并安全清理（删前备份、删后 VACUUM）。</Text>
              <div style={{ marginTop: 16 }}>
                <Button type="primary" loading={busy === "akv"} onClick={akvScan}>扫描孤儿缓存 (约 30 秒)</Button>
              </div>
              {orphan && (
                <Card style={{ marginTop: 16 }}>
                  <Row gutter={16}>
                    <Col span={8}><Statistic title="缓存块总数" value={orphan.totalBlobs} /></Col>
                    <Col span={8}><Statistic title="总占用" value={fmtBytes(orphan.totalBytes)} /></Col>
                    <Col span={8}><Statistic title="可回收(孤儿)" value={fmtBytes(orphan.orphanBytes)} valueStyle={{ color: "#3ecf8e" }} /></Col>
                  </Row>
                  {orphan.orphanCount > 0 && (
                    <Tooltip title={cursorRunning ? "Cursor 运行中，已禁用" : ""}>
                      <Button danger style={{ marginTop: 16 }} loading={busy === "akv"} disabled={cursorRunning} onClick={akvPurge}>
                        删除 {orphan.orphanCount.toLocaleString()} 个孤儿并回收
                      </Button>
                    </Tooltip>
                  )}
                </Card>
              )}
            </div>
          )}
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: "#7c93ff", borderRadius: 8 } }}>
      <AntApp>
        <Main />
      </AntApp>
    </ConfigProvider>
  );
}
