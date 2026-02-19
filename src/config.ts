import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DroidConfig {
  model?: string;
  autoLevel?: "low" | "medium" | "high";
  cwd?: string;
  reasoningEffort?: "off" | "none" | "low" | "medium" | "high";
}

export interface Config {
  telegramBotToken: string;
  allowedChatIds: number[];
  droid: DroidConfig;
}

const CONFIG_PATH = join(homedir(), ".config", "acprouter.json");

export async function loadConfig(): Promise<Config> {
  const raw = await readFile(CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw);

  if (!parsed.telegramBotToken || typeof parsed.telegramBotToken !== "string") {
    throw new Error("Config: telegramBotToken is required");
  }
  if (!Array.isArray(parsed.allowedChatIds) || parsed.allowedChatIds.length === 0) {
    throw new Error("Config: allowedChatIds must be a non-empty array of numbers");
  }

  return {
    telegramBotToken: parsed.telegramBotToken,
    allowedChatIds: parsed.allowedChatIds,
    droid: {
      model: parsed.droid?.model,
      autoLevel: parsed.droid?.autoLevel,
      cwd: parsed.droid?.cwd ?? process.cwd(),
      reasoningEffort: parsed.droid?.reasoningEffort,
    },
  };
}
