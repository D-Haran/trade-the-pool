'use client';

import { realtimeEventSchema, type RealtimeEvent } from '@trade-the-pool/shared';
import { API_URL } from './api-client';

export type ConnectionState = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';
type EventHandler = (event: RealtimeEvent) => void;
type StateHandler = (state: ConnectionState) => void;

const websocketUrl =
  process.env.NEXT_PUBLIC_WS_URL ??
  API_URL.replace(/^http/, 'ws').replace(/\/$/, '') + '/v1/realtime';

class RealtimeClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private offline = false;
  private state: ConnectionState = 'DISCONNECTED';
  private readonly topics = new Map<string, Set<EventHandler>>();
  private readonly stateHandlers = new Set<StateHandler>();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', () => {
        this.offline = true;
        if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.setState('DISCONNECTED');
        this.socket?.close(1000, 'Browser offline');
      });
      window.addEventListener('online', () => {
        this.offline = false;
        this.reconnectAttempt = 0;
        if (this.topics.size) this.connect();
      });
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const handler of this.stateHandlers) handler(state);
  }

  private connect(): void {
    if (this.offline) return;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)
    )
      return;
    this.setState(this.reconnectAttempt ? 'RECONNECTING' : 'CONNECTING');
    const socket = new WebSocket(websocketUrl);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.setState('CONNECTED');
      for (const topic of this.topics.keys()) this.send('subscribe', topic);
    });
    socket.addEventListener('message', (message) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (payload && typeof payload === 'object' && 'error' in payload) {
        const error = (payload as { error?: { code?: string } }).error;
        if (error?.code === 'AUTHENTICATION_REQUIRED')
          window.dispatchEvent(new Event('ttp:session-expired'));
        return;
      }
      if (!payload || typeof payload !== 'object' || !('event' in payload) || !('topic' in payload))
        return;
      const envelope = payload as { event: unknown; topic: string };
      const parsed = realtimeEventSchema.safeParse(envelope.event);
      if (!parsed.success) return;
      for (const handler of this.topics.get(envelope.topic) ?? []) handler(parsed.data);
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      if (this.topics.size) this.scheduleReconnect();
      else this.setState('DISCONNECTED');
    });
    socket.addEventListener('error', () => socket.close());
  }

  private scheduleReconnect(): void {
    if (this.offline) {
      this.setState('DISCONNECTED');
      return;
    }
    if (this.reconnectTimer !== null) return;
    this.setState('RECONNECTING');
    const base = Math.min(15_000, 500 * 2 ** this.reconnectAttempt++);
    const delay = base + Math.floor(Math.random() * Math.min(1_000, base / 2));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(action: 'subscribe' | 'unsubscribe', topic: string): void {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ action, topic }));
  }

  subscribe(topic: string, handler: EventHandler): () => void {
    const handlers = this.topics.get(topic) ?? new Set<EventHandler>();
    const first = handlers.size === 0;
    handlers.add(handler);
    this.topics.set(topic, handlers);
    if (first) this.send('subscribe', topic);
    this.connect();
    return () => {
      const current = this.topics.get(topic);
      current?.delete(handler);
      if (current?.size === 0) {
        this.topics.delete(topic);
        this.send('unsubscribe', topic);
      }
      if (!this.topics.size) {
        if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.socket?.close(1000, 'No active subscriptions');
        this.socket = null;
        this.setState('DISCONNECTED');
      }
    };
  }

  onState(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    handler(this.state);
    return () => this.stateHandlers.delete(handler);
  }
}

export const realtimeClient = new RealtimeClient();
