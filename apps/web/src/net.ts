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
  let failed = false;
  const fail = (why: string) => {
    if (closedByUs || failed) return;
    failed = true;
    queue.length = 0;
    onClose(why);
  };
  ws.onopen = () => { queue.splice(0).forEach((s) => ws.send(s)); };
  ws.onmessage = (e) => {
    try { onMsg(JSON.parse(e.data)); } catch { /* ignore malformed frames */ }
  };
  ws.onclose = () => fail("Connection to server lost. This duel cannot reconnect; return to the lobby to start another.");
  ws.onerror = () => fail("Could not reach the duel server. Return to the lobby and retry when the server is available.");
  return {
    send(m) {
      if (closedByUs || failed || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
      const s = JSON.stringify(m);
      ws.readyState === WebSocket.OPEN ? ws.send(s) : queue.push(s);
    },
    close() { closedByUs = true; queue.length = 0; ws.close(); },
  };
}
