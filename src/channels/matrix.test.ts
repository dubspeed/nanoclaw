import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mocks ---

vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/nanoclaw-test-store',
  ASSISTANT_NAME: 'Andy',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  getLastGroupSync: vi.fn(() => null),
  setLastGroupSync: vi.fn(),
  updateChatName: vi.fn(),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
    },
  };
});

// Build a fake MatrixClient
function createFakeClient() {
  const emitter = new EventEmitter();
  const client = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      emitter.on(event, handler);
    },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    getUserId: vi.fn().mockResolvedValue('@bot:example.com'),
    getUserProfile: vi.fn().mockResolvedValue({ displayname: 'TestUser' }),
    sendMessage: vi.fn().mockResolvedValue({ event_id: '$sent1' }),
    setTyping: vi.fn().mockResolvedValue(undefined),
    getJoinedRooms: vi.fn().mockResolvedValue([]),
    getRoomStateEvent: vi.fn().mockResolvedValue({ name: 'Test Room' }),
    // Expose emitter for triggering events in tests
    _emitter: emitter,
  };
  return client;
}

let fakeClient: ReturnType<typeof createFakeClient>;

vi.mock('matrix-bot-sdk', () => ({
  MatrixClient: vi.fn(function () {
    return fakeClient;
  }),
  SimpleFsStorageProvider: vi.fn(function () {
    return {};
  }),
  AutojoinRoomsMixin: {
    setupOnClient: vi.fn(),
  },
}));

import { MatrixChannel } from './matrix.js';
import { ChannelOpts } from './registry.js';
import { getLastGroupSync, updateChatName, setLastGroupSync } from '../db.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'mx:!room1:example.com': {
        name: 'Test Room',
        folder: 'matrix-test',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function emitMessage(event: Record<string, unknown>) {
  fakeClient._emitter.emit(
    'room.message',
    event.roomId || '!room1:example.com',
    {
      event_id: '$event1',
      sender: '@alice:example.com',
      origin_server_ts: Date.now(),
      content: { msgtype: 'm.text', body: 'Hello' },
      ...event,
    },
  );
}

// --- Tests ---

describe('MatrixChannel', () => {
  beforeEach(() => {
    fakeClient = createFakeClient();
    vi.mocked(getLastGroupSync).mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('connects successfully', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      expect(fakeClient.start).toHaveBeenCalled();
      expect(fakeClient.getUserId).toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      await channel.connect();
      await channel.disconnect();

      expect(channel.isConnected()).toBe(false);
      expect(fakeClient.stop).toHaveBeenCalled();
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered room', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      await channel.connect();

      emitMessage({
        roomId: '!room1:example.com',
        event_id: '$msg1',
        sender: '@alice:example.com',
        content: { msgtype: 'm.text', body: 'Hello Andy' },
      });

      // Flush microtasks
      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'mx:!room1:example.com',
        expect.any(String),
        undefined,
        'matrix',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'mx:!room1:example.com',
        expect.objectContaining({
          content: 'Hello Andy',
          sender: '@alice:example.com',
          sender_name: 'TestUser',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('only emits metadata for unregistered rooms', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      await channel.connect();

      emitMessage({
        roomId: '!unregistered:example.com',
        sender: '@bob:example.com',
        content: { msgtype: 'm.text', body: 'Hello' },
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'mx:!unregistered:example.com',
        expect.any(String),
        undefined,
        'matrix',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('marks own messages as from_me', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      await channel.connect();

      emitMessage({
        roomId: '!room1:example.com',
        sender: '@bot:example.com',
        content: { msgtype: 'm.text', body: 'Bot response' },
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'mx:!room1:example.com',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });

    it('ignores non-text messages', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      await channel.connect();

      emitMessage({
        roomId: '!room1:example.com',
        content: { msgtype: 'm.image', body: 'photo.jpg' },
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Sending messages ---

  describe('sendMessage', () => {
    it('sends message when connected', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      await channel.connect();

      await channel.sendMessage('mx:!room1:example.com', 'Hello');

      expect(fakeClient.sendMessage).toHaveBeenCalledWith(
        '!room1:example.com',
        { msgtype: 'm.text', body: 'Hello' },
      );
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      // Don't connect
      await channel.sendMessage('mx:!room1:example.com', 'Queued');

      expect(fakeClient.sendMessage).not.toHaveBeenCalled();
    });

    it('queues message on send failure', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      await channel.connect();

      fakeClient.sendMessage.mockRejectedValueOnce(new Error('Network error'));

      // Should not throw
      await channel.sendMessage('mx:!room1:example.com', 'Will fail');
    });

    it('splits long messages', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      await channel.connect();

      const longText = 'A'.repeat(5000);
      await channel.sendMessage('mx:!room1:example.com', longText);

      // Should have been split into multiple messages
      expect(fakeClient.sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns mx: prefixed JIDs', () => {
      const channel = new MatrixChannel(
        createTestOpts(),
        'https://matrix.example.com',
        'syt_token',
      );
      expect(channel.ownsJid('mx:!room:example.com')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new MatrixChannel(
        createTestOpts(),
        'https://matrix.example.com',
        'syt_token',
      );
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new MatrixChannel(
        createTestOpts(),
        'https://matrix.example.com',
        'syt_token',
      );
      expect(channel.ownsJid('tg:12345')).toBe(false);
    });
  });

  // --- Typing indicator ---

  describe('setTyping', () => {
    it('sends typing indicator', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      await channel.connect();

      await channel.setTyping('mx:!room1:example.com', true);

      expect(fakeClient.setTyping).toHaveBeenCalledWith(
        '!room1:example.com',
        true,
        30000,
      );
    });

    it('stops typing indicator', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      await channel.connect();

      await channel.setTyping('mx:!room1:example.com', false);

      expect(fakeClient.setTyping).toHaveBeenCalledWith(
        '!room1:example.com',
        false,
        0,
      );
    });
  });

  // --- Room metadata sync ---

  describe('room metadata sync', () => {
    it('syncs room names on connect', async () => {
      fakeClient.getJoinedRooms.mockResolvedValue([
        '!room1:example.com',
        '!room2:example.com',
      ]);
      fakeClient.getRoomStateEvent
        .mockResolvedValueOnce({ name: 'Room One' })
        .mockResolvedValueOnce({ name: 'Room Two' });

      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      await channel.connect();

      // Wait for async sync
      await new Promise((r) => setTimeout(r, 50));

      expect(updateChatName).toHaveBeenCalledWith(
        'mx:!room1:example.com',
        'Room One',
      );
      expect(updateChatName).toHaveBeenCalledWith(
        'mx:!room2:example.com',
        'Room Two',
      );
      expect(setLastGroupSync).toHaveBeenCalled();
    });

    it('skips sync when synced recently', async () => {
      vi.mocked(getLastGroupSync).mockReturnValue(
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      );

      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      await channel.connect();
      await new Promise((r) => setTimeout(r, 50));

      expect(fakeClient.getJoinedRooms).not.toHaveBeenCalled();
    });

    it('forces sync regardless of cache', async () => {
      vi.mocked(getLastGroupSync).mockReturnValue(
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      );

      fakeClient.getJoinedRooms.mockResolvedValue(['!room:example.com']);
      fakeClient.getRoomStateEvent.mockResolvedValue({ name: 'Forced' });

      const opts = createTestOpts();
      const channel = new MatrixChannel(
        opts,
        'https://matrix.example.com',
        'syt_token',
      );

      await channel.connect();
      await channel.syncGroups(true);

      expect(fakeClient.getJoinedRooms).toHaveBeenCalled();
      expect(updateChatName).toHaveBeenCalledWith(
        'mx:!room:example.com',
        'Forced',
      );
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "matrix"', () => {
      const channel = new MatrixChannel(
        createTestOpts(),
        'https://matrix.example.com',
        'syt_token',
      );
      expect(channel.name).toBe('matrix');
    });
  });
});
