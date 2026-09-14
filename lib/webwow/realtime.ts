/**
 * No-op realtime channel for Webwow.
 *
 * Upstream ycode uses Supabase Realtime for collaboration (live layer updates,
 * cursors, resource locks) and for MCP/agent broadcasts. Webwow runs as a
 * single server without a realtime backend, so channels accept every call and
 * simply never deliver messages to other clients. The API surface mirrors
 * `RealtimeChannel` closely enough for the upstream hooks to work unchanged.
 */

type Callback = (...args: any[]) => void;

export class NoopRealtimeChannel {
  readonly topic: string;
  private subscribed = false;
  private listeners: Array<{ type: string; filter: Record<string, unknown>; callback: Callback }> = [];

  constructor(topic: string) {
    this.topic = topic;
  }

  on(type: string, filter: Record<string, unknown>, callback: Callback): this {
    this.listeners.push({ type, filter, callback });
    return this;
  }

  subscribe(callback?: (status: string, err?: Error) => void, _timeout?: number): this {
    this.subscribed = true;
    if (callback) {
      // Asynchronous like the real client so callers can finish wiring listeners first.
      queueMicrotask(() => {
        if (this.subscribed) callback('SUBSCRIBED');
      });
    }
    return this;
  }

  async unsubscribe(_timeout?: number): Promise<'ok' | 'timed out' | 'error'> {
    this.subscribed = false;
    return 'ok';
  }

  async send(_message: Record<string, unknown>, _opts?: Record<string, unknown>): Promise<'ok' | 'timed out' | 'error'> {
    return 'ok';
  }

  async track(_payload: Record<string, unknown>, _opts?: Record<string, unknown>): Promise<'ok' | 'timed out' | 'error'> {
    return 'ok';
  }

  async untrack(_opts?: Record<string, unknown>): Promise<'ok' | 'timed out' | 'error'> {
    return 'ok';
  }

  presenceState(): Record<string, unknown[]> {
    return {};
  }

  get state(): string {
    return this.subscribed ? 'joined' : 'closed';
  }
}

export interface NoopRealtimeApi {
  channel: (topic: string, opts?: Record<string, unknown>) => NoopRealtimeChannel;
  removeChannel: (channel: NoopRealtimeChannel) => Promise<'ok' | 'timed out' | 'error'>;
  removeAllChannels: () => Promise<Array<'ok' | 'timed out' | 'error'>>;
  getChannels: () => NoopRealtimeChannel[];
}

/** Build the realtime part of a client shim. */
export function createNoopRealtime(): NoopRealtimeApi {
  const channels = new Map<string, NoopRealtimeChannel>();

  return {
    channel(topic, _opts) {
      let channel = channels.get(topic);
      if (!channel) {
        channel = new NoopRealtimeChannel(topic);
        channels.set(topic, channel);
      }
      return channel;
    },
    async removeChannel(channel) {
      await channel.unsubscribe();
      channels.delete(channel.topic);
      return 'ok';
    },
    async removeAllChannels() {
      const results: Array<'ok' | 'timed out' | 'error'> = [];
      for (const channel of channels.values()) {
        results.push(await channel.unsubscribe());
      }
      channels.clear();
      return results;
    },
    getChannels() {
      return Array.from(channels.values());
    },
  };
}
