import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import type { Unsubscribe } from "./connection.js";
import type { MistyError } from "./errors.js";
import type { RoomClient } from "./room_client.js";

export interface BridgeRoom {
  doc: Y.Doc;
  awareness: Awareness;
  synced: Promise<void>;
  lost(): MistyError | null;
  onLost(listener: () => void): Unsubscribe;
  onConnection?(listener: (connected: boolean) => void): Unsubscribe;
  onProblem?(listener: (problem: MistyError) => void): Unsubscribe;
  onOption?(listener: (message: Record<string, unknown>) => void): Unsubscribe;
  sendOption?(message: Record<string, unknown>): boolean;
  resend?(clients: number[]): void;
  close(): void;
}

export function bridgeRoomOf(client: RoomClient): BridgeRoom {
  return {
    doc: client.doc,
    awareness: client.awareness,
    synced: client.synced,
    lost: () => client.lost,
    onLost: (listener) => client.onLost(() => listener()),
    onConnection: (listener) => client.onConnection(listener),
    onProblem: (listener) => client.onProblem(listener),
    onOption: (listener) =>
      client.onMessage((message) => {
        if (typeof message.option === "string" && message.option !== "file") listener(message);
      }),
    sendOption: (message) => client.send(message),
    resend: (clients) => client.resend(clients),
    close: () => client.close(),
  };
}
