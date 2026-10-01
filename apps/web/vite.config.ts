import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Card art for WebGL textures needs CORS; the game server proxies it too in prod.
      "/api/img/small": {
        target: "https://images.ygoprodeck.com", changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/img\/small\/(\d+)$/, "/images/cards_small/$1.jpg"),
      },
      "/api/img": {
        target: "https://images.ygoprodeck.com", changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/img\/(\d+)$/, "/images/cards/$1.jpg"),
      },
      "/api": "http://localhost:7777",
      "/ws": { target: "ws://localhost:7777", ws: true },
    },
  },
});
