import fs from 'fs';
import path from 'path';

import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} from 'matrix-bot-sdk';

import { ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const JID_PREFIX = 'mx:';

export class MatrixChannel implements Channel {
  name = 'matrix';

  private client!: MatrixClient;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  private botUserId = '';

  private opts: ChannelOpts;
  private homeserverUrl: string;
  private accessToken: string;

  constructor(
    opts: ChannelOpts,
    homeserverUrl: string,
    accessToken: string,
  ) {
    this.opts = opts;
    this.homeserverUrl = homeserverUrl;
    this.accessToken = accessToken;
  }

  async connect(): Promise<void> {
    const storageDir = path.join(STORE_DIR, 'matrix');
    fs.mkdirSync(storageDir, { recursive: true });

    const storage = new SimpleFsStorageProvider(
      path.join(storageDir, 'bot-storage.json'),
    );

    this.client = new MatrixClient(
      this.homeserverUrl,
      this.accessToken,
      storage,
    );

    // Auto-join rooms when invited
    AutojoinRoomsMixin.setupOnClient(this.client);

    this.botUserId = await this.client.getUserId();
    logger.info({ userId: this.botUserId }, 'Matrix bot identity resolved');

    // Listen for incoming messages
    this.client.on('room.message', async (roomId: string, event: unknown) => {
      try {
        await this.handleMessage(roomId, event as MatrixEvent);
      } catch (err) {
        logger.error({ err, roomId }, 'Error processing Matrix message');
      }
    });

    await this.client.start();
    this.connected = true;
    logger.info(
      { homeserver: this.homeserverUrl, userId: this.botUserId },
      'Connected to Matrix',
    );

    // Flush any messages queued while disconnected
    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Failed to flush Matrix outgoing queue'),
    );

    // Sync room metadata on startup (respects 24h cache)
    this.syncRoomMetadata().catch((err) =>
      logger.error({ err }, 'Initial Matrix room sync failed'),
    );
    if (!this.groupSyncTimerStarted) {
      this.groupSyncTimerStarted = true;
      setInterval(() => {
        this.syncRoomMetadata().catch((err) =>
          logger.error({ err }, 'Periodic Matrix room sync failed'),
        );
      }, GROUP_SYNC_INTERVAL_MS);
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const roomId = jid.slice(JID_PREFIX.length);

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'Matrix disconnected, message queued',
      );
      return;
    }

    try {
      // Split long messages (Matrix has a ~65535 byte limit but keep it readable)
      const MAX_LENGTH = 4000;
      if (text.length <= MAX_LENGTH) {
        await this.client.sendMessage(roomId, {
          msgtype: 'm.text',
          body: text,
        });
      } else {
        const parts = this.splitMessage(text, MAX_LENGTH);
        for (const part of parts) {
          await this.client.sendMessage(roomId, {
            msgtype: 'm.text',
            body: part,
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Matrix message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Matrix message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.client?.stop();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const roomId = jid.slice(JID_PREFIX.length);
      await this.client.setTyping(roomId, isTyping, isTyping ? 30000 : 0);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update Matrix typing status');
    }
  }

  async syncGroups(force: boolean): Promise<void> {
    return this.syncRoomMetadata(force);
  }

  private async handleMessage(
    roomId: string,
    event: MatrixEvent,
  ): Promise<void> {
    // Skip non-text messages
    if (event.content?.msgtype !== 'm.text') return;

    const body = event.content.body;
    if (!body) return;

    const senderId = event.sender;

    // Skip own messages
    const isFromMe = senderId === this.botUserId;

    const jid = `${JID_PREFIX}${roomId}`;
    const timestamp = new Date(event.origin_server_ts).toISOString();

    // Always notify about chat metadata for room discovery
    this.opts.onChatMetadata(jid, timestamp, undefined, 'matrix', true);

    // Only deliver full message for registered groups
    const groups = this.opts.registeredGroups();
    if (groups[jid]) {
      const senderName = await this.getDisplayName(roomId, senderId);

      this.opts.onMessage(jid, {
        id: event.event_id,
        chat_jid: jid,
        sender: senderId,
        sender_name: senderName,
        content: body,
        timestamp,
        is_from_me: isFromMe,
        is_bot_message: isFromMe,
      });
    }
  }

  private async getDisplayName(
    roomId: string,
    userId: string,
  ): Promise<string> {
    try {
      const profile = await this.client.getUserProfile(userId);
      return profile?.displayname || userId.split(':')[0].slice(1);
    } catch {
      return userId.split(':')[0].slice(1);
    }
  }

  private async syncRoomMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping Matrix room sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing room metadata from Matrix...');
      const joinedRooms = await this.client.getJoinedRooms();

      let count = 0;
      for (const roomId of joinedRooms) {
        try {
          const state = await this.client.getRoomStateEvent(
            roomId,
            'm.room.name',
            '',
          );
          if (state?.name) {
            updateChatName(`${JID_PREFIX}${roomId}`, state.name);
            count++;
          }
        } catch {
          // Room may not have a name set
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Matrix room metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Matrix room metadata');
    }
  }

  private splitMessage(text: string, maxLength: number): string[] {
    const parts: string[] = [];
    let remaining = text;
    while (remaining.length > maxLength) {
      // Try to split at a newline
      let splitIdx = remaining.lastIndexOf('\n', maxLength);
      if (splitIdx < maxLength / 2) {
        // No good newline, split at space
        splitIdx = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIdx < maxLength / 2) {
        // No good split point, hard split
        splitIdx = maxLength;
      }
      parts.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).trimStart();
    }
    if (remaining) parts.push(remaining);
    return parts;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Matrix outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const roomId = item.jid.slice(JID_PREFIX.length);
        await this.client.sendMessage(roomId, {
          msgtype: 'm.text',
          body: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Matrix message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

// Matrix event shape (subset of what we need)
interface MatrixEvent {
  event_id: string;
  sender: string;
  origin_server_ts: number;
  content: {
    msgtype?: string;
    body?: string;
  };
}

registerChannel('matrix', (opts: ChannelOpts) => {
  const secrets = readEnvFile([
    'MATRIX_ACCESS_TOKEN',
    'MATRIX_HOMESERVER_URL',
  ]);

  const accessToken =
    process.env.MATRIX_ACCESS_TOKEN || secrets.MATRIX_ACCESS_TOKEN;
  const homeserverUrl =
    process.env.MATRIX_HOMESERVER_URL || secrets.MATRIX_HOMESERVER_URL;

  if (!accessToken || !homeserverUrl) {
    logger.debug('Matrix channel not configured (missing MATRIX_ACCESS_TOKEN or MATRIX_HOMESERVER_URL)');
    return null;
  }

  return new MatrixChannel(opts, homeserverUrl, accessToken);
});
