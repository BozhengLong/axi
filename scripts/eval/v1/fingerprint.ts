import { fingerprint } from "../complex/fingerprint.ts";
import { createHash } from "node:crypto";

export function runtimeFingerprint() {
  const all = fingerprint();
  const hashes = Object.fromEntries(Object.entries(all.hashes).filter(([p]) => p.startsWith("src/") || p.startsWith("scripts/eval/container/") || ["scripts/eval/core.ts", "scripts/eval/adapters.ts", "scripts/eval/trace.ts", "scripts/eval/v1/adapter.ts", "scripts/eval/v1/preview.ts", "scripts/eval/v1/fingerprint.ts"].includes(p)));
  return { runtimeHashes: hashes, runtimeHash: createHash("sha256").update(JSON.stringify(hashes)).digest("hex") };
}
