import { WebSocket } from 'ws';

export interface WsSubscriber {
  connection: WebSocket;
  profileId: string;
}

type ChannelMap = Map<string, Set<WsSubscriber>>;
type ConnectionMap = Map<WebSocket, Set<string>>;

const channels: ChannelMap = new Map();
const connections: ConnectionMap = new Map();

/**
 * Subscribe a connection to a channel.
 * @param channelId - The channel ID
 * @param subscriber - The connection and profile ID
 */
export function subscribeChannel(channelId: string, subscriber: WsSubscriber): void {
  let set = channels.get(channelId);
  if (!set) {
    set = new Set();
    channels.set(channelId, set);
  }
  set.add(subscriber);

  let connectionChannels = connections.get(subscriber.connection);
  if (!connectionChannels) {
    connectionChannels = new Set();
    connections.set(subscriber.connection, connectionChannels);
  }
  connectionChannels.add(channelId);
}

/**
 * Remove a connection from a single channel.
 * @param channelId - The channel ID
 * @param connection - The connection to remove
 */
export function unsubscribeChannel(channelId: string, connection: WebSocket): void {
  const set = channels.get(channelId);
  if (!set) {
    return;
  }
  for (const subscriber of set) {
    if (subscriber.connection === connection) {
      set.delete(subscriber);
      break;
    }
  }
  if (set.size === 0) {
    channels.delete(channelId);
  }

  const connectionChannels = connections.get(connection);
  if (connectionChannels) {
    connectionChannels.delete(channelId);
    if (connectionChannels.size === 0) {
      connections.delete(connection);
    }
  }
}

/**
 * Remove a connection from all channels (on close).
 * @param connection - The connection to remove
 */
export function removeConnection(connection: WebSocket): void {
  const connectionChannels = connections.get(connection);
  if (connectionChannels) {
    for (const channelId of connectionChannels) {
      const set = channels.get(channelId);
      if (set) {
        for (const subscriber of set) {
          if (subscriber.connection === connection) {
            set.delete(subscriber);
            break;
          }
        }
        if (set.size === 0) {
          channels.delete(channelId);
        }
      }
    }
    connections.delete(connection);
  }
}

/**
 * Broadcast a payload to all connections subscribed to a channel.
 * No-op when no connection is subscribed; never throws on a dead socket.
 * @param channelId - The channel ID
 * @param payload - The object to send (JSON-encoded)
 */
export function broadcastToChannel(channelId: string, payload: unknown): void {
  const set = channels.get(channelId);
  if (!set || set.size === 0) {
    return;
  }

  const data = JSON.stringify(payload);
  for (const subscriber of set) {
    if (subscriber.connection.readyState !== WebSocket.OPEN) {
      continue;
    }
    try {
      subscriber.connection.send(data);
    } catch {
      // dead socket during send — broadcast must not break the REST flow
    }
  }
}

/**
 * Drop a profile's live subscriptions to the given channels, e.g. after it is
 * removed from the server. Each socket serves one channel, so it is closed
 * with 4403 and its close handler cleans the registry.
 * @param channelIds - Channels the profile must stop receiving
 * @param profileId - The profile losing access
 */
export function disconnectProfileFromChannels(channelIds: string[], profileId: string): void {
  for (const channelId of channelIds) {
    const set = channels.get(channelId);
    if (!set) continue;
    for (const subscriber of [...set]) {
      if (subscriber.profileId !== profileId) continue;
      unsubscribeChannel(channelId, subscriber.connection);
      try {
        subscriber.connection.close(4403, 'Removed from server');
      } catch {
        // already closing
      }
    }
  }
}
