import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegInputDecoderOptions } from "../src/media-input";

describe("untrusted media input decoders", () => {
  test("retains installed codecs while refusing vulnerable families and aliases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-decoders-"));
    const executable = join(directory, "ffmpeg");
    try {
      await writeFile(executable, `#!/bin/sh
[ "$1" = "-hide_banner" ] && [ "$2" = "-decoders" ] && [ "$#" = 2 ] || exit 9
cat <<'DECODERS'
Decoders:
 V..... = Video
 A..... = Audio
 ------
 A....D aac AAC
 A....D opus Opus
 A....D pcm_s24le PCM
 A....D adpcm_ima_wav IMA WAV
 VF...D h264 H.264
 V....D mjpeg JPEG
 VF...D png PNG
 V....D libaom-av1 libaom AV1 (codec av1)
 V..... libvpx-vp9 libvpx VP9 (codec vp9)
 A....D acelp.kelvin Sipro ACELP.KELVIN
 A....D adpcm_adx ADX
 A....D mace3 MACE 3
 A....D mace6 MACE 6
 VF...D cfhd CineForm
 VF...D vendor-cfhd.1 External decoder (codec cfhd)
DECODERS
`, { mode: 0o700 });
      expect(await ffmpegInputDecoderOptions(executable)).toEqual([
        "-codec_whitelist", "aac,acelp.kelvin,adpcm_ima_wav,h264,libaom-av1,libvpx-vp9,mjpeg,opus,pcm_s24le,png",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("refuses failed, empty and malformed decoder inventories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-decoders-refusal-"));
    try {
      for (const [index, body] of ["exit 1", "echo Decoders:", "echo ' A..... = Audio'", "printf 'Decoders:\\n A....D aac AAC\\n V....D bad,name invalid\\n'", "printf 'Decoders:\\n A....D aac AAC\\n V....D -cfhd invalid\\n'", "printf 'Decoders:\\n A....D aac AAC\\n V....D * invalid\\n'"].entries()) {
        const executable = join(directory, String(index));
        await writeFile(executable, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
        await expect(ffmpegInputDecoderOptions(executable)).rejects.toThrow();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("honors cancellation before inventory discovery", async () => {
    await expect(ffmpegInputDecoderOptions("/does/not/exist", AbortSignal.abort())).rejects.toThrow();
  });
});
