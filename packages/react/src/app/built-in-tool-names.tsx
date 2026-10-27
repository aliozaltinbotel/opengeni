// Tool names the timeline's default registry gives a built-in card, for the
// host extension check that runs at startup. Plain names, so that check loads
// no renderer code; host-extension.test.tsx keeps them in step with the
// registry. A leaf module: growing the contract module itself reshuffles the
// startup chunks.
const KNOWLEDGE_TOOLS = [
  "knowledge_save",
  "knowledge_archive",
  "knowledge_retain_file",
  "knowledge_retain_message",
  "task_note_promote_knowledge",
];
/** Built-in names rendered for the exact name only. */
const BUILT_IN_EXACT_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...KNOWLEDGE_TOOLS.flatMap((name) => [name, `opengeni__${name}`, `mcp__opengeni__${name}`]),
  ...["artifacts_create", "artifacts_publish"].flatMap((name) => [name, `opengeni__${name}`]),
]);
/** Built-in names rendered exactly or as the leaf after an MCP `<server>__` prefix. */
const BUILT_IN_LEAF_TOOL_NAMES: ReadonlySet<string> = new Set(
  [
    "exec_command request_human_input run_on sandboxes_list sandbox_swap",
    "computer_open computer_observe computer_act write_stdin apply_patch_call apply_patch",
    "computer_call browser_screenshot browser_observe browser_act computer_screenshot",
    "computer_click computer_double_click computer_move computer_scroll computer_type",
    "computer_keypress computer_drag web_search_call image_generation_call generate_image",
    "generate_video tool_search view_image sandbox_file_publish environment_set_variable",
    "variable_set_set_variable search_documents knowledge_search memory_propose",
    "set_session_title set_other_session_title",
  ]
    .join(" ")
    .split(" "),
);

/**
 * Whether the timeline's default registry already draws a built-in card for a
 * call named `name`, so a host tool card must not take that name over.
 */
export function isBuiltInToolCardName(name: string): boolean {
  if (BUILT_IN_EXACT_TOOL_NAMES.has(name) || BUILT_IN_LEAF_TOOL_NAMES.has(name)) return true;
  const boundary = name.indexOf("__");
  return boundary >= 0 && BUILT_IN_LEAF_TOOL_NAMES.has(name.slice(boundary + 2));
}

/** Every name listed here, exact-only and leaf-matching, for the drift test. */
export function* builtInToolCardNames(): Generator<string> {
  yield* BUILT_IN_EXACT_TOOL_NAMES;
  yield* BUILT_IN_LEAF_TOOL_NAMES;
}
