import { spawn } from "node:child_process";

let staticPath: string | null = null;
try {
  // Bundled binary so voice notes work even where ffmpeg isn't installed.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  staticPath = require("ffmpeg-static") as string | null;
} catch {
  staticPath = null;
}
const ffmpegBin = () => process.env.FFMPEG_PATH || "ffmpeg";

function run(bin: string, audio: Buffer, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(bin, args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout.on("data", (c) => out.push(c));
    ff.stderr.on("data", (c) => err.push(c));
    ff.on("error", reject);
    ff.on("close", (code) =>
      code === 0 && out.length
        ? resolve(Buffer.concat(out))
        : reject(new Error(`ffmpeg failed (${code}): ${Buffer.concat(err).toString("utf-8").slice(0, 500)}`)),
    );
    ff.stdin.on("error", () => {}); // ffmpeg may close stdin early
    ff.stdin.end(audio);
  });
}

/**
 * Convert any voice-note format (ogg/opus, m4a, amr, webm...) to 16 kHz mono
 * MP3. MP3 has a proper header when streamed (piped WAV carries an unknown
 * length that some model providers reject) and every audio model accepts it.
 */
export async function toAudioInput(
  audio: Buffer,
): Promise<{ buffer: Buffer; format: "mp3" }> {
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-i", "pipe:0",
    "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "libmp3lame", "-b:a", "48k",
    "-f", "mp3", "pipe:1",
  ];
  const candidates = [ffmpegBin(), ...(staticPath ? [staticPath] : [])];
  let lastErr: unknown;
  for (const bin of candidates) {
    try {
      return { buffer: await run(bin, audio, args), format: "mp3" };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
