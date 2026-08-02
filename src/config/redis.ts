import IORedis from "ioredis";

import { env } from "./env";

const isTls = env.REDIS_URI.startsWith("rediss://");

// Shared base options — applied to both the main client and BullMQ connections.
const baseOptions = {
  maxRetriesPerRequest: null,

  // ── TCP keepalive — critical on Heroku ───────────────────────────────────
  // Heroku's router silently drops idle TCP connections after ~55 seconds.
  // Without keepalive, the socket appears open to ioredis but is actually dead —
  // the next command hangs until the OS detects the broken pipe (can take minutes).
  // Setting keepAlive: 10_000 sends a TCP keepalive probe every 10 seconds,
  // so Heroku never sees the connection as idle and never drops it.
  keepAlive: 10_000,

  // ── Connection timeout ───────────────────────────────────────────────────
  // Give up on the initial TCP handshake after 10 seconds.
  connectTimeout: 10_000,

  // ── Speed: automatic command pipelining ─────────────────────────────────
  // ioredis batches all commands fired in the same event-loop tick into a
  // single TCP write. Instead of N separate round-trips (N × 2ms RTT on
  // Heroku Redis), all concurrent commands go in one request.
  enableAutoPipelining: true,

  // NOTE: Do NOT set commandTimeout here.
  // If commandTimeout is set and the connection drops, any commands queued
  // during reconnection will throw "Command timed out" immediately, causing
  // the bot to crash in a loop every 3s. The keepAlive above prevents drops;
  // retryStrategy handles the rare reconnects safely.

  // Reconnect quickly — start at 50ms, cap at 2s.
  retryStrategy: (times: number) => Math.min(times * 50, 2_000),

  enableReadyCheck: false,

  // Heroku managed Redis uses self-signed TLS certs — skip strict CA check.
  ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
};

export const redis = new IORedis(env.REDIS_URI, baseOptions);

/**
 * Create a dedicated IORedis connection for BullMQ.
 *
 * IMPORTANT: BullMQ Queue and Worker must NOT share the main `redis` instance.
 * BullMQ v5 internally duplicates whatever connection you pass and adds its own
 * commandTimeout. When that duplicated connection drops on Heroku, every pending
 * command fires a "Command timed out" error every ~3 seconds, crashing the bot.
 *
 * Fix: give each Queue and each Worker its own fresh IORedis instance via this
 * factory. These connections use the same options as the main client (keepAlive,
 * connectTimeout, TLS) but are independent, so BullMQ can manage their lifecycle
 * without interfering with the app's primary redis client.
 */
export function createBullMQConnection(): IORedis {
  return new IORedis(env.REDIS_URI, {
    ...baseOptions,
    // BullMQ's Worker uses blocking commands (XREAD/BRPOP) that hold the
    // connection open. enableAutoPipelining conflicts with blocking commands,
    // so disable it on BullMQ connections.
    enableAutoPipelining: false,
  });
}
