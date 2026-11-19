/**
 * Convert an Atlassian Document Format node into plain text.
 * The text is complete: nothing is truncated, and the original ADF is kept by the caller.
 */

interface AdfMark {
  type?: string;
  attrs?: Record<string, unknown>;
}

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: AdfMark[];
}

function isNode(value: unknown): value is AdfNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attrString(node: AdfNode, key: string): string {
  const value = node.attrs?.[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function joinBlocks(content: AdfNode[] | undefined): string {
  const parts: string[] = [];
  for (const child of content ?? []) {
    const rendered = renderBlock(child);
    if (rendered.length > 0) parts.push(rendered);
  }
  return parts.join("\n\n");
}

function renderInline(content: AdfNode[] | undefined): string {
  let text = "";
  for (const child of content ?? []) text += renderInlineNode(child);
  return text;
}

function renderMedia(node: AdfNode): string {
  const name = attrString(node, "alt") || attrString(node, "filename") || attrString(node, "id");
  return `[attachment: ${name}]`;
}

function renderInlineNode(node: AdfNode): string {
  switch (node.type) {
    case "text": {
      const text = node.text ?? "";
      const link = node.marks?.find((mark) => mark.type === "link");
      const href = link?.attrs?.href;
      if (typeof href === "string" && href.length > 0) return `${text} (${href})`;
      return text;
    }
    case "hardBreak":
      return "\n";
    case "mention": {
      const name = attrString(node, "text") || attrString(node, "displayName") || attrString(node, "id");
      return name.length > 0 ? `@${name}` : "";
    }
    case "emoji":
      return attrString(node, "text") || attrString(node, "shortName");
    case "media":
      return renderMedia(node);
    case "inlineCard":
    case "blockCard":
      return attrString(node, "url") || attrString(node, "href");
    default:
      if (node.content && node.content.length > 0) return renderBlock(node);
      return typeof node.text === "string" ? node.text : "";
  }
}

function prefixBlock(marker: string, inner: string): string {
  if (inner.length === 0) return marker.trimEnd();
  const lines = inner.split("\n");
  const pad = " ".repeat(marker.length);
  return lines.map((line, index) => {
    if (index === 0) return marker + line;
    if (line.length === 0) return line;
    return pad + line;
  }).join("\n");
}

function renderList(
  content: AdfNode[] | undefined,
  kind: "bullet" | "ordered",
  attrs: Record<string, unknown> | undefined,
): string {
  const start = typeof attrs?.order === "number" && Number.isFinite(attrs.order) ? attrs.order : 1;
  const lines: string[] = [];
  let number = start;
  for (const item of content ?? []) {
    const marker = kind === "bullet" ? "- " : `${number}. `;
    if (kind === "ordered") number += 1;
    lines.push(prefixBlock(marker, renderBlock(item)));
  }
  return lines.join("\n");
}

function renderTableRow(node: AdfNode): string {
  const cells = (node.content ?? []).map((cell) => renderBlock(cell).replaceAll("\n", " "));
  return cells.join(" | ");
}

function renderBlock(node: AdfNode): string {
  switch (node.type) {
    case "doc":
    case "blockquote":
    case "panel":
    case "mediaSingle":
    case "mediaGroup":
    case "expand":
    case "nestedExpand":
    case "listItem":
    case "tableCell":
    case "tableHeader":
      return joinBlocks(node.content);
    case "paragraph":
    case "heading":
    case "codeBlock":
      return renderInline(node.content);
    case "bulletList":
      return renderList(node.content, "bullet", node.attrs);
    case "orderedList":
      return renderList(node.content, "ordered", node.attrs);
    case "table":
      return (node.content ?? []).map((row) => renderTableRow(row)).join("\n");
    case "tableRow":
      return renderTableRow(node);
    case "media":
      return renderMedia(node);
    case "rule":
      return "";
    default:
      if (node.content && node.content.length > 0) return joinBlocks(node.content);
      return renderInlineNode(node);
  }
}

/** Plain text for a description, comment, or worklog body. Non-documents become an empty string. */
export function adfToText(value: unknown): string {
  if (!isNode(value)) return "";
  return renderBlock(value);
}
