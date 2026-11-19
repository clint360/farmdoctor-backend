import { spawn } from "node:child_process";

/**
 * Convert any voice-note format (ogg/opus, m4a, amr, webm...) to 16 kHz mono
 * WAV, which every audio-capable OpenRouter model accepts. Needs ffmpeg.
 */
export function toWav(audio: Buffer, sampleRate = 16000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-ac", "1", "-ar", String(sampleRate),
      "-f", "wav", "pipe:1",
    ]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout.on("data", (c) => out.push(c));
    ff.stderr.on("data", (c) => err.push(c));
    ff.on("error", reject);
    ff.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`ffmpeg failed (${code}): ${Buffer.concat(err).toString("utf-8")}`)),
    );
    ff.stdin.on("error", () => {}); // ffmpeg may close stdin early
    ff.stdin.end(audio);
  });
}
