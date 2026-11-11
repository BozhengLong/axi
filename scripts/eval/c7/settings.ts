import { join } from "node:path";
import { STORE } from "../core.ts";

export const STUDY = join(STORE, "c7-20261111");
export const IMAGE = "sha256:92840cfa30671118f34ee7d60e412ef68b7c0a713d5e5ba01a52a490f0bdc8c6";
export const RUN_MS = 30 * 60_000;
export const GRADE_MS = 15 * 60_000;
export type TaskId = "C7-L" | "C7-O";
export const TASKS: TaskId[] = ["C7-L", "C7-O"];
export const schedule = [
  { task: "C7-L", repeat: 1, agents: ["axi", "claude"] },
  { task: "C7-O", repeat: 1, agents: ["claude", "axi"] },
  { task: "C7-L", repeat: 2, agents: ["claude", "axi"] },
  { task: "C7-O", repeat: 2, agents: ["axi", "claude"] },
  { task: "C7-L", repeat: 3, agents: ["axi", "claude"] },
  { task: "C7-O", repeat: 3, agents: ["claude", "axi"] },
] as const;
