import { MistyError, safely } from "./errors.js";
import { isFrame } from "./protocol.js";
import type { Frame, MethodName, Methods, TopicName, Topics } from "./protocol.js";

export interface Channel {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
  start?(): void;
  close(): void;
}

export type Unsubscribe = () => void;

export type CallArgs<M extends MethodName> = [void] extends [Methods[M][0]]
  ? [params?: Methods[M][0]]
  : [params: Methods[M][0]];

export interface ConnectionOptions {
  timeoutMs?: number;
}

interface Subscription {
  topic: string;
  params: unknown;
  listener: (data: unknown) => void;
  onEnd?: (error?: MistyError) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

const CALL_TIMEOUTS: Partial<Record<MethodName, number>> = {
  "files.pick": 30 * 60_000,
  "files.open": 10 * 60_000,
  "files.save": 10 * 60_000,
  "files.upload": 10 * 60_000,
  "files.download": 10 * 60_000,
  "room.sync": 2 * 60_000,
  "room.serialized": 2 * 60_000,
  "calls.join": 5 * 60_000,
};

const closedError = () => new MistyError("closed", "The connection to Misty is closed.");

export class Connection {
  private nextId = 1;
  private closed = false;
  private channel: Channel;
  private held: Frame[] | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly mcpListeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly resetListeners = new Set<() => void>();

  constructor(
    channel: Channel,
    private readonly options: ConnectionOptions = {},
  ) {
    this.channel = channel;
    this.attach(channel);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  call<M extends MethodName>(
    method: M,
    ...args: CallArgs<M>
  ): Promise<Methods[M][1]> {
    if (this.closed) return Promise.reject(closedError());
    const id = this.nextId++;
    const timeout = CALL_TIMEOUTS[method] ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new MistyError("internal", "Misty didn't answer in time."));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.send({ t: "req", id, method, params: args[0] });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new MistyError("internal", String(error)));
      }
    });
  }

  subscribe<T extends TopicName>(
    topic: T,
    params: Topics[T][0],
    listener: (data: Topics[T][1]) => void,
    onEnd?: (error?: MistyError) => void,
  ): Unsubscribe {
    if (this.closed) {
      onEnd?.(closedError());
      return () => {};
    }
    const id = this.nextId++;
    this.subscriptions.set(id, { topic, params, listener: listener as (data: unknown) => void, onEnd });
    this.send({ t: "sub", id, topic, params });
    return () => {
      if (this.subscriptions.delete(id) && !this.closed) this.send({ t: "unsub", id });
    };
  }

  sendMcp(message: unknown): void {
    if (!this.closed) this.send({ t: "mcp", message });
  }

  onMcp(listener: (message: unknown) => void): Unsubscribe {
    this.mcpListeners.add(listener);
    return () => this.mcpListeners.delete(listener);
  }

  onClose(listener: () => void): Unsubscribe {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onReset(listener: () => void): Unsubscribe {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  }

  replace(channel: Channel): void {
    if (this.closed) return;
    this.channel.onmessage = null;
    this.channel.close();
    this.channel = channel;
    this.held = [];
    this.attach(channel);
    const restarted = new MistyError("internal", "Misty restarted the app's connection.");
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const call of calls) {
      clearTimeout(call.timer);
      call.reject(restarted);
    }
  }

  resume(): void {
    if (this.closed || !this.held) return;
    const held = this.held;
    this.held = null;
    for (const [id, sub] of this.subscriptions) this.send({ t: "sub", id, topic: sub.topic, params: sub.params });
    for (const frame of held) {
      if (frame.t === "mcp" || (frame.t === "req" && this.pending.has(frame.id))) this.send(frame);
    }
    for (const listener of [...this.resetListeners]) safely(listener);
  }

  close(): void {
    if (this.closed) return;
    if (!this.held) {
      for (const id of this.subscriptions.keys()) safely(() => this.channel.postMessage({ t: "unsub", id }));
    }
    this.closed = true;
    this.held = null;
    this.channel.onmessage = null;
    this.channel.close();
    const closed = closedError();
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const call of calls) {
      clearTimeout(call.timer);
      call.reject(closed);
    }
    const subs = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const sub of subs) safely(() => sub.onEnd?.(closed));
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) safely(listener);
    this.mcpListeners.clear();
    this.resetListeners.clear();
  }

  private attach(channel: Channel): void {
    channel.onmessage = (event) => this.receive(event.data);
    channel.start?.();
  }

  private send(frame: Frame): void {
    if (this.held && !(frame.t === "req" && frame.method === "hello")) {
      this.held.push(frame);
      return;
    }
    this.channel.postMessage(frame);
  }

  private receive(data: unknown): void {
    if (!isFrame(data)) return;
    switch (data.t) {
      case "res": {
        const call = this.pending.get(data.id);
        if (!call) return;
        this.pending.delete(data.id);
        clearTimeout(call.timer);
        if (data.ok) call.resolve(data.result);
        else call.reject(MistyError.fromWire(data.error));
        return;
      }
      case "evt": {
        const sub = this.subscriptions.get(data.id);
        const payload = data.data;
        if (sub) safely(() => sub.listener(payload));
        return;
      }
      case "end": {
        const sub = this.subscriptions.get(data.id);
        if (!sub) return;
        this.subscriptions.delete(data.id);
        const error = data.error ? MistyError.fromWire(data.error) : undefined;
        safely(() => sub.onEnd?.(error));
        return;
      }
      case "mcp": {
        const message = data.message;
        for (const listener of [...this.mcpListeners]) safely(() => listener(message));
        return;
      }
      default:
        return;
    }
  }
}
