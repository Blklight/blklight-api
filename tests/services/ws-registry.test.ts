import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  broadcastToChannel,
  disconnectProfileFromChannels,
  subscribeChannel,
} from '../../src/features/chat/ws-registry';

function fakeSocket() {
  return { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket & {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

describe('disconnectProfileFromChannels', () => {
  it('stops broadcasts to the removed profile and closes its socket', () => {
    const removed = fakeSocket();
    const staying = fakeSocket();
    subscribeChannel('ch-1', { connection: removed, profileId: 'p-removed' });
    subscribeChannel('ch-1', { connection: staying, profileId: 'p-staying' });

    disconnectProfileFromChannels(['ch-1'], 'p-removed');
    broadcastToChannel('ch-1', { type: 'message' });

    expect(removed.close).toHaveBeenCalledWith(4403, 'Removed from server');
    expect(removed.send).not.toHaveBeenCalled();
    expect(staying.send).toHaveBeenCalledTimes(1);
    expect(staying.close).not.toHaveBeenCalled();
  });
});
