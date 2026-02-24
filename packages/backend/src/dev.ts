// Starts the server and then sets up a Cloudflare quick tunnel.

import { ready } from "./server";
import { Tunnel } from "cloudflared";

ready.then(() => {
  console.log("[tunnel] Starting Cloudflare quick tunnel...");

  const tunnel = new Tunnel(["--url", "http://localhost:3000"]);

  tunnel.once("url", (url: string) => {
    console.log(`[tunnel] ✔ Public URL: ${url}`);
  });

  tunnel.once("connected", (conn: { id: string; ip: string; location: string }) => {
    console.log(`[tunnel] Connected (${conn.location}, ${conn.ip})`);
  });

  tunnel.on("error", (err: Error) => {
    console.error("[tunnel] Error:", err.message);
  });

  const cleanup = () => {
    console.log("\n[tunnel] Shutting down...");
    tunnel.stop();
    process.exit();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
});
