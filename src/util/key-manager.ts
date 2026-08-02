import { GoogleGenerativeAI } from "@google/generative-ai";

import { env } from "../config/env";

interface KeyEntry {
  key: string;
  genAI: GoogleGenerativeAI;
  failedAt?: number;
}

const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

export class APIKeyManager {
  private keys: KeyEntry[] = [];
  private currentIndex = 0;

  initialize(): void {
    this.keys = (env.GEMINI_API_KEYS as string[]).map((key) => ({
      key,
      genAI: new GoogleGenerativeAI(key),
    }));
  }

  getAvailableKeysCount(): number {
    const now = Date.now();
    return this.keys.filter((k) => !k.failedAt || now - k.failedAt > FAILURE_COOLDOWN_MS).length;
  }

  async getWorkingKey(): Promise<{ key: string; genAI: GoogleGenerativeAI }> {
    const now = Date.now();
    const available = this.keys.filter((k) => !k.failedAt || now - k.failedAt > FAILURE_COOLDOWN_MS);

    if (available.length === 0) {
      for (const k of this.keys) delete k.failedAt;
      if (this.keys.length === 0) throw new Error("No Gemini API keys configured");
      return { key: this.keys[0]!.key, genAI: this.keys[0]!.genAI };
    }

    const entry = available[this.currentIndex % available.length]!;
    this.currentIndex = (this.currentIndex + 1) % available.length;
    return { key: entry.key, genAI: entry.genAI };
  }

  async markKeyAsFailed(key: string): Promise<void> {
    const entry = this.keys.find((k) => k.key === key);
    if (entry) entry.failedAt = Date.now();
  }
}
