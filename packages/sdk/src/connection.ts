import { MistyError } from "./errors.js";
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

interface Subscription {
  topic: string;
  listener: (data: unknown) => void;
  onEnd?: (error?: MistyError) => void;
}

export class Connection {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly mcpListeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(private readonly channel: Channel) {
    channel.onmessage = (event) => this.receive(event.data);
    channel.start?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  call<M extends MethodName>(
    method: M,
    ...args: CallArgs<M>
  ): Promise<Methods[M][1]> {
    if (this.closed) return Promise.reject(new MistyError("closed", "The connection to Misty is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.send({ t: "req", id, method, params: args[0] });
    });
  }

  subscribe<T extends TopicName>(
    topic: T,
    params: Topics[T][0],
    listener: (data: Topics[T][1]) => void,
    onEnd?: (error?: MistyError) => void,
  ): Unsubscribe {
    if (this.closed) {
      onEnd?.(new MistyError("closed", "The connection to Misty is closed."));
      return () => {};
    }
    const id = this.nextId++;
    this.subscriptions.set(id, { topic, listener: listener as (data: unknown) => void, onEnd });
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.onmessage = null;
    this.channel.close();
    const closed = new MistyError("closed", "The connection to Misty is closed.");
    for (const { reject } of this.pending.values()) reject(closed);
    this.pending.clear();
    for (const sub of this.subscriptions.values()) sub.onEnd?.(closed);
    this.subscriptions.clear();
    for (const listener of [...this.closeListeners]) listener();
    this.closeListeners.clear();
    this.mcpListeners.clear();
  }

  private send(frame: Frame): void {
    this.channel.postMessage(frame);
  }

  private receive(data: unknown): void {
    if (!isFrame(data)) return;
    switch (data.t) {
      case "res": {
        const call = this.pending.get(data.id);
        if (!call) return;
        this.pending.delete(data.id);
        if (data.ok) call.resolve(data.result);
        else call.reject(MistyError.fromWire(data.error));
        return;
      }
      case "evt":
        this.subscriptions.get(data.id)?.listener(data.data);
        return;
      case "end": {
        const sub = this.subscriptions.get(data.id);
        if (!sub) return;
        this.subscriptions.delete(data.id);
        sub.onEnd?.(data.error ? MistyError.fromWire(data.error) : undefined);
        return;
      }
      case "mcp":
        for (const listener of [...this.mcpListeners]) listener(data.message);
        return;
      default:
        return;
    }
  }
}
