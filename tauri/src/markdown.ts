// 轻量 Markdown → HTML 渲染（从网页版移植）。先转义再变换，输出可安全 innerHTML。

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderMarkdown(src: string): string {
  if (!src) return "";
  const codeBlocks: string[] = [];
  src = src.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const idx = codeBlocks.length;
    const lng = lang.trim() || "code";
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    codeBlocks.push(
      `<div class="code-wrap"><div class="code-head"><span class="code-lang">${escapeHtml(lng)}</span>` +
        `<button class="copy-btn" type="button">复制</button></div><pre><code>${escaped}</code></pre></div>`
    );
    return `\u0000CB${idx}\u0000`;
  });

  const inlineCodes: string[] = [];
  src = src.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code class="inline">${escapeHtml(c)}</code>`);
    return `\u0000IC${idx}\u0000`;
  });

  src = escapeHtml(src);

  const inline = (t: string) =>
    t
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>");

  const lines = src.split("\n");
  let out = "";
  let i = 0;
  let listType: string | null = null;
  const closeList = () => {
    if (listType) {
      out += `</${listType}>`;
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const cb = line.match(/^\u0000CB(\d+)\u0000$/);
    if (cb) { closeList(); out += codeBlocks[+cb[1]]; i++; continue; }
    if (/^\s*$/.test(line)) { closeList(); i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }

    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]+$/.test(lines[i + 1])) {
      closeList();
      const splitRow = (r: string) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const header = splitRow(line);
      i += 2;
      let tbl = "<table><thead><tr>" + header.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
        tbl += "<tr>" + splitRow(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
        i++;
      }
      out += tbl + "</tbody></table>";
      continue;
    }

    if (/^>\s?/.test(line)) {
      closeList();
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(inline(lines[i].replace(/^>\s?/, ""))); i++; }
      out += `<blockquote>${q.join("<br>")}</blockquote>`;
      continue;
    }

    let m = line.match(/^\s*[-*+]\s+(.*)$/);
    if (m) {
      if (listType !== "ul") { closeList(); out += "<ul>"; listType = "ul"; }
      out += `<li>${inline(m[1])}</li>`; i++; continue;
    }
    m = line.match(/^\s*\d+\.\s+(.*)$/);
    if (m) {
      if (listType !== "ol") { closeList(); out += "<ol>"; listType = "ol"; }
      out += `<li>${inline(m[1])}</li>`; i++; continue;
    }

    closeList();
    const para = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\u0000CB\d+\u0000$/.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i]); i++;
    }
    out += `<p>${para.map(inline).join("<br>")}</p>`;
  }
  closeList();

  out = out.replace(/\u0000IC(\d+)\u0000/g, (_m, idx) => inlineCodes[+idx]);
  out = out.replace(/\u0000CB(\d+)\u0000/g, (_m, idx) => codeBlocks[+idx]);
  return out;
}
