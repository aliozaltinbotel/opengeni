import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserRecordingVideoError,
  encodeBrowserRecording,
  jpegSize,
  parseBrowserRecordingBundle,
} from "../src/browser-recording-video";

const ffmpeg = process.env.OPENGENI_TEST_FFMPEG ?? Bun.which("ffmpeg");
const ffprobe = ffmpeg ? (Bun.which("ffprobe") ?? ffmpeg.replace(/ffmpeg$/u, "ffprobe")) : null;
const withFfmpeg = ffmpeg ? test : test.skip;

async function jpegFrame(directory: string, name: string, color: string, size: string) {
  const path = join(directory, name);
  const run = Bun.spawnSync([
    ffmpeg!,
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${size}`,
    "-frames:v",
    "1",
    path,
  ]);
  expect(run.exitCode).toBe(0);
  return new Uint8Array(await readFile(path));
}

function bundle(
  frames: { t: number; data: Uint8Array }[],
  durationMs: number,
  actions: unknown[] = [],
) {
  let offset = 0;
  const index = frames.map((frame) => {
    const entry = { t: frame.t, offset, length: frame.data.byteLength, targetId: "tab" };
    offset += frame.data.byteLength;
    return entry;
  });
  const header = JSON.stringify({
    version: 1,
    recordingId: "00000000-0000-4000-8000-000000000001",
    startedAt: "2026-10-20T20:00:00.000Z",
    durationMs,
    mediaType: "image/jpeg",
    frames: index,
    actions,
  });
  return Buffer.concat([
    Buffer.from(`OGREC1\n${header}\n`),
    ...frames.map((frame) => Buffer.from(frame.data)),
  ]);
}

describe("browser recording video", () => {
  test("restricts decoders before opening concat recording inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recording-decoder-guard-"));
    try {
      const executable = join(directory, "ffmpeg");
      await writeFile(executable, `#!/bin/sh
if [ "$2" = "-decoders" ]; then
  printf 'Decoders:\n V....D mjpeg JPEG\n A....D mace6 MACE6\n V....D cfhd CineForm\n'
  exit 0
fi
guarded=0
previous=''
for argument in "$@"; do
  if [ "$previous" = "-codec_whitelist" ] && [ "$argument" = "mjpeg" ]; then guarded=1; fi
  if [ "$argument" = "-i" ] && [ "$guarded" != 1 ]; then exit 9; fi
  previous="$argument"
  output="$argument"
done
printf 'recording' > "$output"
`, { mode: 0o700 });
      const frame = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 2, 0, 0, 0]);
      const result = await encodeBrowserRecording({
        bundle: bundle([{ t: 0, data: frame }], 1_000), ffmpegPath: executable,
      });
      expect(result.frameCount).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects foreign or truncated bundles", () => {
    expect(() => parseBrowserRecordingBundle(new TextEncoder().encode("nope"))).toThrow(
      BrowserRecordingVideoError,
    );
    const broken = bundle([{ t: 0, data: Uint8Array.from([0xff, 0xd8, 1]) }], 1_000);
    expect(() => parseBrowserRecordingBundle(broken.subarray(0, broken.byteLength - 2))).toThrow(
      "out of range",
    );
  });

  withFfmpeg("encodes changed frames with their real timing and keeps the action log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recording-video-test-"));
    try {
      const red = await jpegFrame(directory, "a.jpg", "red", "640x400");
      const blue = await jpegFrame(directory, "b.jpg", "blue", "640x400");
      // A frame from a differently sized tab is fitted into the first size.
      const green = await jpegFrame(directory, "c.jpg", "green", "320x480");
      expect(jpegSize(red)).toEqual({ width: 640, height: 400 });
      const actions = [{ t: 1_900, kind: "action", targetId: "tab", action: { type: "click" } }];
      const result = await encodeBrowserRecording({
        bundle: bundle(
          [
            { t: 40, data: red },
            { t: 2_000, data: blue },
            { t: 4_500, data: green },
          ],
          6_000,
          actions,
        ),
        ffmpegPath: ffmpeg!,
      });
      expect(result).toMatchObject({ frameCount: 3, durationMs: 6_000, width: 640, height: 400 });
      const output = join(directory, "out.mp4");
      await Bun.write(output, result.video);
      const probe = Bun.spawnSync([
        ffprobe!,
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,width,height:format=duration",
        "-of",
        "json",
        output,
      ]);
      const facts = JSON.parse(probe.stdout.toString()) as {
        streams: { codec_name: string; width: number; height: number }[];
        format: { duration: string };
      };
      expect(facts.streams[0]).toMatchObject({ codec_name: "h264", width: 640, height: 400 });
      expect(Number(facts.format.duration)).toBeGreaterThan(5.5);
      expect(Number(facts.format.duration)).toBeLessThan(7);
      const log = JSON.parse(new TextDecoder().decode(result.actionLog));
      expect(log).toMatchObject({ durationMs: 6_000, actions, pageChanges: [40, 2_000, 4_500] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  withFfmpeg("a recording with no frames fails clearly", async () => {
    await expect(
      encodeBrowserRecording({ bundle: bundle([], 3_000), ffmpegPath: ffmpeg! }),
    ).rejects.toMatchObject({ code: "no_frames" });
  });
});
