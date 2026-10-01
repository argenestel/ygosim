import { describe, it, expect } from "vitest";
import { startServer } from "../src/server.js";

/**
 * Integration test: Requires @ygosim/engine to be available and data/cards.json to exist.
 * Skipped if engine is unavailable or data is missing.
 */
describe("Live Integration Test (WebSocket)", { skip: !process.env.YGOSIM_TEST_ENGINE }, () => {
  it("should play a full AI game via WebSocket", async () => {
    const server = await startServer({ port: 7778 });
    console.log(`Server started on port ${server.port}`);

    try {
      // Wait for server to be fully ready
      await new Promise((r) => setTimeout(r, 1000));

      // Simulate WebSocket client using Node.js ws
      const WebSocket = await import("ws").then((m) => m.WebSocket);

      const messages: any[] = [];
      let promptCount = 0;
      const maxPrompts = 300;

      return new Promise<void>((resolve, reject) => {
        const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
        console.log(`Connecting to ${wsUrl}`);
        const ws = new WebSocket(wsUrl);

        ws.on("open", () => {
          console.log("WebSocket connected");
          // Send hello
          ws.send(JSON.stringify({ type: "hello", name: "TestPlayer", kind: "human" }));
        });

        ws.on("message", (data) => {
          try {
            const msg = JSON.parse(String(data));
            messages.push(msg);
            console.log(`[msg ${messages.length}] ${msg.type}`);

            switch (msg.type) {
              case "welcome":
                // Create a room with AI opponent - use sample deck from engine
                const sampleDeck = {
                  main: Array(40).fill(0).map((_, i) => 36996508 + i),
                  extra: [],
                  side: [],
                };
                console.log("Sending create_room");
                ws.send(JSON.stringify({
                  type: "create_room",
                  vsAI: true,
                  aiLevel: "normal",
                  deck: sampleDeck,
                }));
                break;

              case "prompt":
                // Answer with first legal option
                if (promptCount < maxPrompts) {
                  promptCount++;
                  const firstOption = msg.prompt.options[0];
                  if (firstOption) {
                    console.log(`[prompt ${promptCount}] answering with ${firstOption.id}`);
                    ws.send(JSON.stringify({
                      type: "action",
                      action: { promptId: msg.prompt.promptId, choose: [firstOption.id] },
                    }));
                  }
                } else {
                  console.log("Max prompts reached, closing");
                  ws.close();
                }
                break;

              case "events":
                // Check for win event
                if (msg.events?.some((e: any) => e.t === "win")) {
                  const winEvent = msg.events.find((e: any) => e.t === "win");
                  console.log(`Game ended with winner: ${winEvent.winner}`);
                  ws.close();
                }
                break;

              case "error":
                console.error(`Server error: ${msg.message}`);
                reject(new Error(`Server error: ${msg.message}`));
                break;
            }
          } catch (e) {
            reject(e);
          }
        });

        ws.on("close", () => {
          console.log(`WebSocket closed, messages received: ${messages.length}, prompts: ${promptCount}`);
          expect(messages.length).toBeGreaterThan(0);
          expect(messages.some((m) => m.type === "welcome")).toBe(true);
          expect(messages.some((m) => m.type === "room")).toBe(true);
          expect(promptCount).toBeGreaterThan(0);
          console.log(`Test complete: ${promptCount} prompts answered, ${messages.length} total messages`);
          resolve();
        });

        ws.on("error", (err) => {
          console.error("WebSocket error:", err);
          reject(err);
        });

        // Timeout after 30 seconds
        setTimeout(() => {
          console.log("Test timeout, closing WebSocket");
          ws.close();
          reject(new Error("WebSocket test timeout"));
        }, 30000);
      });
    } finally {
      await server.close();
    }
  });
});
