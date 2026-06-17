import { invoke } from "@tauri-apps/api/core";

export interface DbInfo {
  path: string;
  exists: boolean;
  cursorRunning: boolean;
  sizeBytes: number;
  walBytes: number;
  journalMode?: string;
  pageSize?: number;
  pageCount?: number;
}

export interface ConvSummary {
  id: string;
  name: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  mode?: string;
  archived?: boolean;
  messageCount?: number;
  sizeBytes?: number;
}

export interface Thinking { text: string; durationMs?: number; }
export interface ToolCall { name?: string; status?: string; args: string; result: string; }
export interface Bajie {
  kind: "reply" | "wait" | "send";
  content?: string;
  agentStatus?: string;
  received?: string;
  receivedKind?: string;
  suggestions?: string[];
  message?: string;
  messageType?: string;
  target?: string;
}
export interface Bubble {
  id?: string;
  role: "user" | "assistant";
  createdAt?: string;
  text: string;
  thinking?: Thinking;
  toolCalls: ToolCall[];
  bajie?: Bajie;
  error?: string;
}
export interface ConvMeta {
  id: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  status?: string;
  model?: string;
  mode?: string;
  contextTokensUsed?: number;
  contextTokenLimit?: number;
  todos: any[];
  messageCount: number;
}
export interface ConversationData { meta: ConvMeta; bubbles: Bubble[]; }

export interface SearchHit { id: string; name: string; matches: number; snippets: string[]; }
export interface SearchResult { query: string; results: SearchHit[]; matchCount: number; conversationCount: number; truncated: boolean; }

export interface Stats {
  totalConversations: number;
  conversationsWithBody: number;
  totalMessages: number;
  byModel: [string, number][];
  byDay: [string, number][];
}
export interface PrefixStat { pfx: string; n: number; bytes: number; }
export interface VacuumResult { beforeBytes: number; afterBytes: number; freedBytes: number; }
export interface DeleteResult {
  deletedConversations: number;
  deletedKeys: number;
  removedFromIndex: number;
  backupPath?: string;
  vacuum?: VacuumResult;
  vacuumError?: string;
}
export interface OrphanScan { totalBlobs: number; totalBytes: number; orphanCount: number; orphanBytes: number; }
export interface PurgeResult { deletedBlobs: number; backupPath?: string; vacuum?: VacuumResult; vacuumError?: string; }

export const api = {
  info: () => invoke<DbInfo>("get_info"),
  setDbPath: (path: string) => invoke<DbInfo>("set_db_path", { path }),
  conversations: () => invoke<{ conversations: ConvSummary[]; sizeCacheReady: boolean }>("get_conversations"),
  conversation: (id: string) => invoke<ConversationData>("get_conversation", { id }),
  search: (q: string) => invoke<SearchResult>("search", { q }),
  stats: () => invoke<Stats>("get_stats"),
  prefixStats: () => invoke<PrefixStat[]>("get_prefix_stats"),
  scanSizes: () => invoke<number>("scan_sizes"),
  backup: () => invoke<string>("backup"),
  vacuum: () => invoke<VacuumResult>("vacuum"),
  deleteConversations: (ids: string[], backup: boolean, vacuum: boolean) =>
    invoke<DeleteResult>("delete_conversations", { ids, backup, vacuum }),
  agentkvScan: () => invoke<OrphanScan>("agentkv_scan"),
  agentkvPurge: (backup: boolean, vacuum: boolean) => invoke<PurgeResult>("agentkv_purge", { backup, vacuum }),
  exportMd: (id: string) => invoke<string>("export_md", { id }),
};

export function fmtBytes(n?: number): string {
  if (n == null) return "-";
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(1) + " " + u[i];
}
export function fmtDate(ms?: number | string): string {
  if (!ms) return "-";
  const d = new Date(ms);
  if (isNaN(+d)) return "-";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
