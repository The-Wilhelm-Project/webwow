import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

export interface ChannelLifecycle {
  /**
   * Track a created channel + client for race-safe teardown.
   * Returns false if teardown already ran — the channel is removed immediately
   * in that case, so the caller should abort initialization.
   */
  track: (channel: RealtimeChannel, client: SupabaseClient) => boolean;
  /** True once `teardown()` has been called. */
  readonly cancelled: boolean;
  /**
   * Remove the tracked channel via `client.removeChannel()` and mark the
   * lifecycle as cancelled. Safe to call repeatedly.
   */
  teardown: () => void;
}

/**
 * Race-safe lifecycle wrapper for an async-initialized Supabase realtime channel.
 *
 * Plain `channel.unsubscribe()` does not remove the channel from supabase-js'
 * internal registry; `client.removeChannel()` does. This helper also handles
 * the case where the effect's cleanup runs before async init resolves, which
 * would otherwise leak the channel.
 */
export function createChannelLifecycle(): ChannelLifecycle {
  let isCancelled = false;
  let trackedChannel: RealtimeChannel | null = null;
  let trackedClient: SupabaseClient | null = null;

  return {
    track(channel, client) {
      if (isCancelled) {
        client.removeChannel(channel);
        return false;
      }
      trackedChannel = channel;
      trackedClient = client;
      return true;
    },
    get cancelled() {
      return isCancelled;
    },
    teardown() {
      isCancelled = true;
      if (trackedChannel && trackedClient) {
        trackedClient.removeChannel(trackedChannel);
        trackedChannel = null;
        trackedClient = null;
      }
    },
  };
}
