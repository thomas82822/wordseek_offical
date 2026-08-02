import { redis } from "../config/redis";

/**
 * Safe, non-blocking alternative to `redis.keys(pattern)`.
 *
 * `redis.keys()` is O(N) and blocks the entire Redis server while it scans every
 * key. In production this can freeze all other clients for seconds on large
 * keyspaces and cause ioredis command timeouts.
 *
 * `scanKeys()` uses the SCAN command which iterates in small, non-blocking
 * batches (COUNT 200 per call). It is safe to call at any time in production.
 */
export async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, batch] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      200,
    );
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  return keys;
}
