import type { SyntaxNode } from "./language.js";
import { setClause } from "./composer-model.js";
import { children, insertMember, textOf } from "./model.js";

export interface WireEnd {
  kind: string;
  name: string;
  path: string;
  node: SyntaxNode;
}

const kinds: Record<string, string> = {
  SOURCE_DECL: "source",
  FUNCTION_DECL: "function",
  RESOURCE_DECL: "resource",
  CHANNEL_DECL: "channel",
  WORKFLOW_DECL: "workflow",
};

function normalize(kind: string) {
  return kinds[kind] ?? kind;
}

/** The wire label this pair writes, when the language has that wire. */
export function snapTargets(fromKind: string, toKind: string): boolean {
  return labelFor(normalize(fromKind), normalize(toKind)) !== null;
}

function labelFor(fromKind: string, toKind: string): "runs" | "uses" | "sends" | "on" | null {
  if (fromKind === "source" && toKind === "function") return "runs";
  if (fromKind === "function" && toKind === "resource") return "uses";
  if (fromKind === "function" && toKind === "channel") return "sends";
  if (fromKind === "channel" && toKind === "function") return "on";
  return null;
}

function messageName(text: string, channel: SyntaxNode) {
  return text.slice(channel.start, channel.end).match(/\bmessage\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? null;
}

function hasUse(text: string, block: SyntaxNode, name: string) {
  return children(block, "USE_DECL").some((decl) => {
    const raw = textOf(text, decl).trim();
    return raw === name || raw.startsWith(`${name} `);
  });
}

function hasSend(text: string, block: SyntaxNode, channel: string) {
  return children(block, "SEND_DECL").some((decl) => {
    const raw = textOf(text, decl).trim();
    return raw.endsWith(` ${channel}`) || raw.endsWith(`.${channel}`);
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove one declaration, the newline after it, and a single blank line before it.
 * The ranges come from the declaration node the compiler just parsed.
 */
export function deleteDeclaration(text: string, node: { start: number; end: number }) {
  let start = node.start;
  let end = node.end;
  if (end < text.length && text[end] === "\r") end += 1;
  if (end < text.length && text[end] === "\n") end += 1;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (/^\s*$/.test(text.slice(lineStart, start))) start = lineStart;
  if (start > 0 && text[start - 1] === "\n") {
    const previousEnd = start - 1;
    const previousStart = text.lastIndexOf("\n", previousEnd - 1) + 1;
    if (/^\s*$/.test(text.slice(previousStart, previousEnd))) start = previousStart;
  }
  return text.slice(0, start) + text.slice(end);
}

function useHead(text: string, decl: SyntaxNode) {
  return textOf(text, decl).trim().split(/\s+/)[0] ?? "";
}

function namesResource(text: string, decl: SyntaxNode, name: string) {
  const head = useHead(text, decl);
  return head === name || head.endsWith(`.${name}`);
}

function namesChannel(text: string, decl: SyntaxNode, channel: string) {
  const raw = textOf(text, decl).trim();
  return raw.endsWith(` ${channel}`) || raw.endsWith(`.${channel}`);
}

function dropOnly(text: string, block: SyntaxNode, kind: string, decl: SyntaxNode) {
  return children(block, kind).length === 1 ? deleteDeclaration(text, block) : deleteDeclaration(text, decl);
}

/** Remove one language wire. The declarations stay. */
export function cutWire(text: string, from: WireEnd, to: WireEnd, label: string): string {
  if (from.path !== to.path) throw new Error("Snap wires between declarations in the same file.");
  if (label === "calls") throw new Error("Workflow steps stay in the workflow source.");
  const expected = labelFor(normalize(from.kind), normalize(to.kind));
  if (expected !== label) throw new Error("This wire is not a Forge connection.");
  if (label === "runs") {
    const target = children(from.node, "TARGET_DECL")[0];
    return target ? deleteDeclaration(text, target) : text;
  }
  if (label === "uses") {
    const block = children(from.node, "USES_BLOCK")[0];
    const decl = block && children(block, "USE_DECL").find((item) => namesResource(text, item, to.name));
    return block && decl ? dropOnly(text, block, "USE_DECL", decl) : text;
  }
  if (label === "sends") {
    const block = children(from.node, "SENDS_BLOCK")[0];
    const decl = block && children(block, "SEND_DECL").find((item) => namesChannel(text, item, to.name));
    return block && decl ? dropOnly(text, block, "SEND_DECL", decl) : text;
  }
  const pattern = new RegExp(
    `(^|\\n)[^\\n]*\\bon\\s+${escapeRegExp(from.name)}\\.[A-Za-z_][A-Za-z0-9_]*\\s*->\\s*${escapeRegExp(to.name)}\\s*(?=\\n|$)`,
    "g",
  );
  return text.replace(pattern, "").replace(/\n{3,}/g, "\n\n");
}

/** Patch a real language wire between two declarations. Both must live in one file. */
export function snapWire(text: string, from: WireEnd, to: WireEnd): { text: string; label: string } {
  if (from.path !== to.path) throw new Error("Snap wires between declarations in the same file.");
  const label = labelFor(normalize(from.kind), normalize(to.kind));
  if (!label) {
    throw new Error("Snap a source to a function, a function to a resource or channel, or a channel to a function.");
  }
  if (label === "runs") {
    return { text: setClause(text, from.node, "TARGET_DECL", "->", to.name), label };
  }
  if (label === "uses") {
    const block = children(from.node, "USES_BLOCK")[0];
    if (block && hasUse(text, block, to.name)) return { text, label };
    const member = block ? `${to.name} read` : `uses {\n  ${to.name} read\n}`;
    return { text: insertMember(text, block ?? from.node, member), label };
  }
  const message = messageName(text, label === "sends" ? to.node : from.node);
  if (!message) throw new Error("This channel has no message to send.");
  if (label === "sends") {
    const block = children(from.node, "SENDS_BLOCK")[0];
    if (block && hasSend(text, block, to.name)) return { text, label };
    const member = block ? `${message} to ${to.name}` : `sends {\n  ${message} to ${to.name}\n}`;
    return { text: insertMember(text, block ?? from.node, member), label };
  }
  const subscription = `on ${from.name}.${message} -> ${to.name}`;
  const withInput = setClause(text, to.node, "FUNCTION_INPUT", "input", `${from.name}.${message}`);
  if (new RegExp(`(?:^|\\n)\\s*${escapeRegExp(subscription)}\\s*(?:\\n|$)`).test(withInput)) {
    return { text: withInput, label };
  }
  return { text: `${withInput.replace(/\s*$/, "")}\n\n${subscription}\n`, label };
}
