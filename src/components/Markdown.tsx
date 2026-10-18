import { Fragment, type ReactNode } from "react";

// Minimal renderer for the report Markdown this app generates (headings, lists, tables,
// blockquotes, bold, inline code). Output is React elements; no raw HTML is injected.

function inline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong>
      : p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code>
        : <Fragment key={i}>{p}</Fragment>,
  );
}

export function Markdown({ source }: { source: string }) {
  const lines = source.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("# ")) { out.push(<h1 key={i}>{inline(l.slice(2))}</h1>); i++; continue; }
    if (l.startsWith("## ")) { out.push(<h2 key={i}>{inline(l.slice(3))}</h2>); i++; continue; }
    if (l.startsWith("> ")) { out.push(<blockquote key={i}>{inline(l.slice(2))}</blockquote>); i++; continue; }
    if (l.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        if (!/^\|[-| ]+\|$/.test(lines[i])) rows.push(lines[i].slice(1, -1).split(" | ").map((c) => c.trim()));
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        <div className="table-wrap" key={`t${i}`}><table>
          <thead><tr>{head.map((h, k) => <th key={k}>{inline(h)}</th>)}</tr></thead>
          <tbody>{body.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }
    if (/^\s*- /.test(l)) {
      const items: { depth: number; text: string }[] = [];
      while (i < lines.length && /^\s*- /.test(lines[i])) { items.push({ depth: lines[i].search(/\S/) >= 2 ? 1 : 0, text: lines[i].replace(/^\s*- /, "") }); i++; }
      out.push(<ul key={`u${i}`}>{items.map((it, k) => <li key={k} style={it.depth ? { marginLeft: "1.2rem" } : undefined}>{inline(it.text)}</li>)}</ul>);
      continue;
    }
    if (l.trim() === "") { i++; continue; }
    out.push(<p key={i}>{inline(l)}</p>);
    i++;
  }
  return <div className="md">{out}</div>;
}
