import type { ClientMsg, ServerMsg } from "@ygosim/protocol";
import { wsUrl } from "./api";

export interface Conn {
  send(m: ClientMsg): void;
  close(): void;
}

/** Thin WebSocket wrapper that queues sends until open. */
export function connect(onMsg: (m: ServerMsg) => void, onClose: (why: string) => void): Conn {
  const ws = new WebSocket(wsUrl());
  const queue: string[] = [];
  let closedByUs = false;
  ws.onopen = () => { queue.splice(0).forEach((s) => ws.send(s)); };
  ws.onmessage = (e) => {
    try { onMsg(JSON.parse(e.data)); } catch { /* ignore malformed frames */ }
  };
  ws.onclose = () => { if (!closedByUs) onClose("Connection to server lost"); };
  ws.onerror = () => onClose("Could not reach the duel server (is it running on :7777?)");
  return {
    send(m) {
      const s = JSON.stringify(m);
      ws.readyState === WebSocket.OPEN ? ws.send(s) : queue.push(s);
    },
    close() { closedByUs = true; ws.close(); },
  };
}
