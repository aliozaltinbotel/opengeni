import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const drizzle = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

/** The text of one `EXECUTE format($create$ ... enqueue_host_usage_event_export ... $create$, target_schema);` block. */
function usageEnqueueBlock(sql: string): string {
  const start = sql.indexOf(
    "  EXECUTE format($create$\n    CREATE OR REPLACE FUNCTION opengeni_private.enqueue_host_usage_event_export()",
  );
  if (start < 0) throw new Error("usage enqueue block not found");
  const end = sql.indexOf("  $create$, target_schema);", start);
  if (end < 0) throw new Error("usage enqueue block end not found");
  return sql.slice(start, end + "  $create$, target_schema);".length);
}

describe("migration 0668 usage event call attributes", () => {
  test("adds a bounded, immutable, nullable column without rewriting historical usage", async () => {
    const sql = await readFile(join(drizzle, "0668_usage_event_call_attributes.sql"), "utf8");
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS attributes jsonb");
    expect(sql).toContain("usage_events_attributes_shape_check");
    expect(sql).toContain("octet_length(attributes::text) <= 4096");
    expect(sql).toContain("usage_events_call_attributes_check");
    expect(sql).toContain("BEFORE UPDATE OF attributes ON usage_events");
    expect(sql).not.toMatch(/UPDATE\s+usage_events\s+SET/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+usage_events/i);
  });

  test("rebuilds 0533's usage enqueue with exactly one change: the payload names attributes", async () => {
    const before = usageEnqueueBlock(
      await readFile(join(drizzle, "0533_turn_surface_analytics.sql"), "utf8"),
    );
    const after = usageEnqueueBlock(
      await readFile(join(drizzle, "0668_usage_event_call_attributes.sql"), "utf8"),
    );
    const anchor = "        'billingProviderEventId', NEW.billing_provider_event_id\n      );";
    const replacement =
      "        'billingProviderEventId', NEW.billing_provider_event_id,\n        'attributes', NEW.attributes\n      );";
    expect(before.split(anchor).length - 1).toBe(1);
    expect(after.split(replacement).length - 1).toBe(1);
    // Reversal: undoing the one edit gives 0533's definition byte for byte.
    expect(after.replace(replacement, anchor)).toBe(before);
    // 0107's lineage contract keeps holding the capture lock.
    expect(after).toContain("FOR SHARE");
  });
});
