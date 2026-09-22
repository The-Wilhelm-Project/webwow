/**
 * Global concurrency limiter for Supabase (PostgREST) queries.
 *
 * When recursive collection resolution fires unbounded Promise.all
 * fan-outs, dozens (or hundreds) of HTTP requests hit the PostgREST
 * endpoint simultaneously. This exhausts the upstream PostgreSQL
 * connection pool, causing all queries to queue and the overall
 * request to balloon from seconds to minutes.
 *
 * This semaphore caps the maximum in-flight Supabase queries so
 * parallelism is preserved but bounded.
 *
 * State lives on globalThis to survive Next.js HMR reloads.
 */

const MAX_CONCURRENT = 10;

const g = globalThis as unknown as {
  __sbLimiter?: { running: number; queue: Array<() => void> };
};

if (!g.__sbLimiter) {
  g.__sbLimiter = { running: 0, queue: [] };
}

function release() {
  const s = g.__sbLimiter!;
  s.running--;
  const next = s.queue.shift();
  if (next) {
    s.running++;
    next();
  }
}

export async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  const s = g.__sbLimiter!;
  if (s.running < MAX_CONCURRENT) {
    s.running++;
  } else {
    await new Promise<void>(resolve => {
      s.queue.push(resolve);
    });
  }
  try {
    return await fn();
  } finally {
    release();
  }
}
