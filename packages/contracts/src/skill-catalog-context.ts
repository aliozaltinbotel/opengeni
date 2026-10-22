/** Durable, model-visible catalog context. Text markers survive SDK/provider replay. */
export const SKILL_CATALOG_CONTEXT_PREFIX = "<opengeni_skill_catalog>\n";
export const SKILL_CATALOG_CONTEXT_SUFFIX = "\n</opengeni_skill_catalog>";
const GUIDANCE =
  "This is the current configured Skill index and replaces earlier configured Skill indexes. " +
  "Entries describe discoverability, not permission or full instructions. " +
  "Use skill_read for instructions and skill_search for current discovery; tool authorization remains authoritative.\n\n";

export function skillCatalogContextItem(catalog: string): Record<string, unknown> {
  return {
    type: "message",
    role: "developer",
    content: SKILL_CATALOG_CONTEXT_PREFIX + GUIDANCE + catalog + SKILL_CATALOG_CONTEXT_SUFFIX,
  };
}

/** Accept the Chat Completions projection and SDK text-part normalization too. */
export function readSkillCatalogContext(item: Record<string, unknown>): string | null {
  if (item.type === "unknown" && item.providerData && typeof item.providerData === "object") {
    const data = item.providerData as Record<string, unknown>;
    if (data.type === "message") return readSkillCatalogContext(data);
  }
  if (item.type !== "message" || (item.role !== "developer" && item.role !== "system")) return null;
  const content =
    typeof item.content === "string"
      ? item.content
      : Array.isArray(item.content) &&
          item.content.every(
            (part) =>
              part &&
              (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
              typeof part.text === "string",
          )
        ? item.content.map((part) => part.text).join("")
        : null;
  const prefix = SKILL_CATALOG_CONTEXT_PREFIX + GUIDANCE;
  return content?.startsWith(prefix) && content.endsWith(SKILL_CATALOG_CONTEXT_SUFFIX)
    ? content.slice(prefix.length, -SKILL_CATALOG_CONTEXT_SUFFIX.length)
    : null;
}

export function latestSkillCatalogContext(
  items: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const catalog = readSkillCatalogContext(items[index]!);
    if (catalog !== null) return skillCatalogContextItem(catalog);
  }
  return undefined;
}

export type SkillCatalogDescriptor = Readonly<{
  id: string;
  name: string;
  description: string;
  /** Immutable host origins for the exact descriptor; excluded from model-visible catalog text. */
  modelSourceRefs?: readonly import("./index").ModelSourceRef[];
}>;

export const SKILL_CATALOG_MAX_BYTES = 32 * 1024;
export const SKILL_CATALOG_MAX_ENTRIES = 128;

/** Descriptors only; file bodies and complete path inventories are read on demand. */
export function formatSkillCatalog(descriptors: readonly SkillCatalogDescriptor[]): string {
  const byId = new Map<string, SkillCatalogDescriptor>();
  for (const entry of descriptors) {
    if (!entry.id || !entry.name || !entry.description)
      throw new Error("Invalid Skill catalog descriptor.");
    const prior = byId.get(entry.id);
    if (prior && (prior.name !== entry.name || prior.description !== entry.description)) {
      throw new Error(`Conflicting Skill catalog identity: ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }
  const ordered = [...byId.values()].sort((a, b) => {
    if (a.id === "builtin:skill-management") return -1;
    if (b.id === "builtin:skill-management") return 1;
    const left = `${a.name}\u0000${a.id}`;
    const right = `${b.name}\u0000${b.id}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const header = skillCatalogHeader(byId.has("builtin:skill-management"));
  const lines = [header];
  if (ordered.length === 0) lines.push("No configured Skills are currently available.");
  let bytes = Buffer.byteLength(header, "utf8");
  let included = 0;
  for (const entry of ordered) {
    const line = `- ${JSON.stringify({ id: entry.id, name: entry.name, description: entry.description })}`;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    // Reserve the short omission notice rather than silently overrun the bound.
    if (included >= SKILL_CATALOG_MAX_ENTRIES || bytes + lineBytes > SKILL_CATALOG_MAX_BYTES - 256)
      continue;
    lines.push(line);
    bytes += lineBytes;
    included += 1;
  }
  const omitted = ordered.length - included;
  if (omitted > 0)
    lines.push(
      `${omitted} additional Skills are omitted from this short index. Use skill_search to find them.`,
    );
  return lines.join("\n");
}

/**
 * Ids of the entries a rendered catalog lists. Entries omitted by the bounds
 * above are not listed, so they are not in the set; header and notice lines
 * are never entries.
 */
export function skillCatalogEntryIds(catalog: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const line of catalog.split("\n")) {
    if (!line.startsWith("- {")) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line.slice(2));
    } catch {
      continue;
    }
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}

function skillCatalogHeader(managementSelected: boolean): string {
  return [
    "## Skills",
    "Use skill_read to read a relevant Skill without a sandbox. Omit paths for SKILL.md, or supply paths to read exactly those files.",
    managementSelected
      ? "For finding, installing, creating, or editing Skills, read the skill-management Skill. Management tools are lazy and available through tool search."
      : "Management tools are lazy and available through tool search.",
    "The following entries are descriptors, not the Skill instructions. Use the id when names are ambiguous.",
  ].join("\n");
}

/** Exact native formatter grammar; arbitrary text is never turned into source evidence. */
export function readNativeSkillCatalogDescriptors(
  catalog: string,
): readonly SkillCatalogDescriptor[] | null {
  if (Buffer.byteLength(catalog, "utf8") > SKILL_CATALOG_MAX_BYTES) return null;
  const lines = catalog.split("\n");
  const header = lines.splice(0, 4).join("\n");
  if (header !== skillCatalogHeader(false) && header !== skillCatalogHeader(true)) return null;
  const notice = lines
    .at(-1)
    ?.match(
      /^([1-9][0-9]*) additional Skills are omitted from this short index\. Use skill_search to find them\.$/,
    );
  if (notice) {
    if (!Number.isSafeInteger(Number(notice[1]))) return null;
    lines.pop();
  }
  if (lines.length === 1 && lines[0] === "No configured Skills are currently available.")
    return notice ? null : [];
  if (lines.length === 0 && !notice) return null;
  const entries: SkillCatalogDescriptor[] = [];
  for (const line of lines) {
    if (!line.startsWith("- {")) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(2));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      !record.id ||
      typeof record.name !== "string" ||
      !record.name ||
      typeof record.description !== "string" ||
      !record.description
    )
      return null;
    const entry = { id: record.id, name: record.name, description: record.description };
    if (line !== `- ${JSON.stringify(entry)}`) return null;
    entries.push(entry);
  }
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) return null;
  // Reuse the formatter for ordering and entry bounds; omission may hide management itself.
  const formatted = formatSkillCatalog(entries).split("\n").slice(4);
  if (entries.length === 0) formatted.length = 0;
  return JSON.stringify(formatted) === JSON.stringify(lines) ? entries : null;
}
