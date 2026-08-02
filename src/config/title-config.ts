import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface TitleTier {
  threshold: number;
  name: string;
}

const CONFIG_PATH = join(process.cwd(), "data", "title_config.json");

export const DEFAULT_TITLES: TitleTier[] = [
  { threshold: 100_000, name: "Legendary Sage" },
  { threshold: 50_000, name: "Grand Champion" },
  { threshold: 25_000, name: "Word Wizard" },
  { threshold: 10_000, name: "Lexicon Master" },
  { threshold: 5_000, name: "Word Artisan" },
  { threshold: 1_000, name: "Word Seeker" },
];

export function loadTitles(): TitleTier[] {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return (parsed as TitleTier[]).sort((a, b) => b.threshold - a.threshold);
      }
    }
  } catch {
    // fallback to defaults
  }
  return DEFAULT_TITLES;
}

export function saveTitles(titles: TitleTier[]): void {
  const sorted = [...titles].sort((a, b) => b.threshold - a.threshold);
  writeFileSync(CONFIG_PATH, JSON.stringify(sorted, null, 2));
}

export function getTitleForScore(score: number): string | null {
  const titles = loadTitles();
  const tier = titles.find((t) => score >= t.threshold);
  return tier?.name ?? null;
}
