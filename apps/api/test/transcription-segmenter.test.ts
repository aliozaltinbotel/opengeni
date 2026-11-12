import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createFfmpegTranscriptionSegmenter,
  TranscriptionSegmenterError,
} from "../src/transcription/segmenter";

async function* chunks(): AsyncIterable<Uint8Array> {
  yield new Uint8Array([1]);
  yield new Uint8Array([2]);
}

describe("ffmpeg transcription segmenter", () => {
  test("refuses unavailable decoder policy before reading uploaded chunks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opengeni-decoder-refusal-"));
    const ffmpegPath = join(directory, "ffmpeg");
    let chunksRead = false;
    try {
      await writeFile(ffmpegPath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      const segmenter = createFfmpegTranscriptionSegmenter({ ffmpegPath });
      const segments = segmenter.segment({
        sourceMimeType: "audio/mp4", totalDurationMilliseconds: 1_000, providerSegmentSeconds: 1,
        chunks: (async function* () { chunksRead = true; yield new Uint8Array([1]); })(),
      });
      await expect(segments[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        code: "unavailable", retryable: true,
      });
      expect(chunksRead).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["audio/webm;codecs=opus", "audio/mp4"])("guards %s before normalizing bounded PCM WAV segments", async (sourceMimeType) => {
    const directory = await mkdtemp(join(tmpdir(), "opengeni-fake-ffmpeg-"));
    const ffmpegPath = join(directory, "ffmpeg");
    await writeFile(
      ffmpegPath,
      `#!/bin/sh
if [ "$1" = "-version" ]; then
  exit 0
fi
if [ "$2" = "-decoders" ]; then
  printf 'Decoders:\n A....D pcm_s16le PCM\n A....D opus Opus\n A....D adpcm_adx ADX\n A....D mace6 MACE6\n V....D cfhd CineForm\n'
  exit 0
fi
guarded=0
previous=''
for argument in "$@"; do
  if [ "$previous" = "-codec_whitelist" ] && [ "$argument" = "opus,pcm_s16le" ]; then guarded=1; fi
  if [ "$argument" = "-i" ] && [ "$guarded" != 1 ]; then exit 9; fi
  previous="$argument"
  output="$argument"
done
output_directory="\${output%/*}"
printf '\\001' > "$output_directory/segment-000000.wav"
printf '\\002' > "$output_directory/segment-000001.wav"
`,
    );
    await chmod(ffmpegPath, 0o755);

    try {
      const segmenter = createFfmpegTranscriptionSegmenter({ ffmpegPath });
      expect(await segmenter.available()).toBe(true);
      const segments = [];
      for await (const segment of segmenter.segment({
        sourceMimeType,
        totalDurationMilliseconds: 70_000,
        providerSegmentSeconds: 50,
        chunks: chunks(),
      })) {
        segments.push(segment);
      }
      expect(segments).toEqual([
        {
          segmentNumber: 0,
          startMilliseconds: 0,
          durationMilliseconds: 50_000,
          mimeType: "audio/wav",
          bytes: new Uint8Array([1]),
        },
        {
          segmentNumber: 1,
          startMilliseconds: 50_000,
          durationMilliseconds: 20_000,
          mimeType: "audio/wav",
          bytes: new Uint8Array([2]),
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects more than 1,000 projected segments before invoking ffmpeg", async () => {
    const segmenter = createFfmpegTranscriptionSegmenter({
      ffmpegPath: "/does/not/exist",
    });
    let caught: unknown;
    try {
      for await (const _segment of segmenter.segment({
        sourceMimeType: "audio/webm",
        totalDurationMilliseconds: 1_001_000,
        providerSegmentSeconds: 1,
        chunks: chunks(),
      })) {
        // The bounds check must fail before yielding or spawning.
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TranscriptionSegmenterError);
    expect(caught).toMatchObject({ code: "too_large", retryable: false });
  });
});
