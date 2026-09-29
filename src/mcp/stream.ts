type WsEvent = {
  event: string;
  channel?: string;
  data: string;
};

type EventCallback = (events: Record<string, unknown>[]) => void;

export class StreamClient {
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, EventCallback>();
  private socketId: string | null = null;
  private activityTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private url: string;
  private connected = false;
  private shuttingDown = false;
  private connectedAt: number | null = null;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.addEventListener('open', () => {
          log('WebSocket connection opened');
        });

        this.ws.addEventListener('message', (evt) => {
          const msg = JSON.parse(String(evt.data)) as WsEvent;
          this.handleMessage(msg, resolve);
        });

        this.ws.addEventListener('close', () => {
          log('WebSocket closed');
          this.connected = false;
          this.connectedAt = null;
          this.clearActivityTimeout();
          if (!this.shuttingDown) this.scheduleReconnect();
        });

        this.ws.addEventListener('error', (err) => {
          log(`WebSocket error: ${String(err)}`);
          if (!this.connected) reject(new Error('WebSocket connection failed'));
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleMessage(msg: WsEvent, onConnect?: (value: void) => void) {
    switch (msg.event) {
      case 'pusher:connection_established': {
        const data = JSON.parse(msg.data) as { socket_id: string; activity_timeout?: number };
        this.socketId = data.socket_id;
        this.connected = true;
        this.connectedAt = Date.now();
        this.reconnectAttempts = 0;
        this.resetActivityTimeout(data.activity_timeout || 120);
        log('Connected to stream');

        // Resubscribe to all channels after reconnect
        for (const channel of this.subscriptions.keys()) {
          this.sendSubscribe(channel);
        }

        onConnect?.();
        break;
      }
      case 'pusher:pong':
        this.resetActivityTimeout(120);
        break;
      case 'pusher:error': {
        const errData = JSON.parse(msg.data) as { message?: string; code?: number };
        log(`Stream error: ${errData.message} (code: ${errData.code})`);
        break;
      }
      case 'pusher_internal:subscription_succeeded':
        log(`Subscribed to ${msg.channel}`);
        break;
      default:
        // Skip internal protocol events
        if (msg.event.startsWith('pusher:') || msg.event.startsWith('pusher_internal:')) break;

        if (msg.channel && this.subscriptions.has(msg.channel)) {
          try {
            const data = JSON.parse(msg.data) as { events?: Record<string, unknown>[] };
            const events = data.events || [data as unknown as Record<string, unknown>];
            this.subscriptions.get(msg.channel)?.(events);
          } catch {
            log(`Failed to parse event data for channel ${msg.channel}`);
          }
        }
    }
  }

  private sendSubscribe(channel: string) {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel } }));
    }
  }

  subscribe(channel: string, callback: EventCallback) {
    this.subscriptions.set(channel, callback);
    this.sendSubscribe(channel);
  }

  unsubscribe(channel: string) {
    this.subscriptions.delete(channel);
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify({ event: 'pusher:unsubscribe', data: { channel } }));
    }
  }

  getSubscriptions(): { channels: string[]; connected: boolean; uptime: number | null } {
    return {
      channels: [...this.subscriptions.keys()],
      connected: this.connected,
      uptime: this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1000) : null,
    };
  }

  disconnect() {
    this.shuttingDown = true;
    this.clearActivityTimeout();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.connectedAt = null;
  }

  private resetActivityTimeout(seconds: number) {
    this.clearActivityTimeout();
    this.activityTimeout = setTimeout(() => {
      if (this.ws && this.connected) {
        this.ws.send(JSON.stringify({ event: 'pusher:ping' }));
      }
    }, seconds * 1000);
  }

  private clearActivityTimeout() {
    if (this.activityTimeout) {
      clearTimeout(this.activityTimeout);
      this.activityTimeout = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log('Max reconnect attempts reached');
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;
    log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => log(`Reconnect failed: ${String(err)}`));
    }, delay);
  }
}

function log(msg: string) {
  process.stderr.write(`[ws] ${msg}\n`);
}
