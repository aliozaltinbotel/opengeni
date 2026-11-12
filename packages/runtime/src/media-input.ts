import { execFile } from "node:child_process";

// The MACE fix covers both decoders sharing mace_decode_frame. These exclusions
// apply before stream-info probing, not only to streams selected for output.
// Upstream fixes: 1836ef968469 (ADX), aafb5c655edc (MACE), db05df9d135f (CFHD).
const UNSAFE_DECODERS = new Set(["adpcm_adx", "mace3", "mace6", "cfhd"]);

/**
 * FFmpeg's codec_whitelist accepts exact names, not negative patterns. Discover
 * the configured executable's trusted inventory without opening media, retaining
 * every other installed decoder (including PCM variants and attached artwork).
 * The same option reaches avformat probing and avcodec_open2, including concat
 * children. Callers must place these options before their input, never output.
 */
export async function ffmpegInputDecoderOptions(
  executable: string,
  signal?: AbortSignal,
): Promise<readonly ["-codec_whitelist", string]> {
  signal?.throwIfAborted();
  const inventory = await new Promise<string>((resolve, reject) => {
    execFile(executable, ["-hide_banner", "-decoders"], {
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      ...(signal ? { signal } : {}),
      env: { ...process.env, LC_ALL: "C" },
    }, (error, stdout) => {
      if (error) reject(new Error("Media decoder policy is unavailable", { cause: error }));
      else resolve(stdout);
    });
  });
  if (!/^Decoders:\s*$/mu.test(inventory)) {
    throw new Error("Media decoder inventory is invalid");
  }
  const allowed = new Set<string>();
  for (const line of inventory.split(/\r?\n/u)) {
    if (!/^\s*[VAS][A-Z.]{5}\s/u.test(line) || /^\s*[VAS][A-Z.]{5}\s+=/u.test(line)) continue;
    const match = /^\s*[VAS][A-Z.]{5}\s+([a-zA-Z0-9_][a-zA-Z0-9_.-]*)(?:\s+(.*))?$/u.exec(line);
    const name = match?.[1];
    if (!name) throw new Error("Media decoder inventory is invalid");
    const codec = /\(codec ([a-zA-Z0-9_][a-zA-Z0-9_.-]*)\)/u.exec(match?.[2] ?? "")?.[1] ?? name;
    if (!UNSAFE_DECODERS.has(name) && !UNSAFE_DECODERS.has(codec)) allowed.add(name);
  }
  if (allowed.size === 0) throw new Error("Media decoder inventory is empty");
  return ["-codec_whitelist", [...allowed].sort().join(",")];
}
