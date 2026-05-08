#!/usr/bin/env node
import { startProjectTreeServer } from "./web-server.js";

const server = await startProjectTreeServer({
  port: Number(process.env.PROJECT_TREE_PORT || 0),
  root: process.env.PROJECT_TREE_ROOT || null
});

console.log(`Project Lens: ${server.url}`);
console.log(`Root: ${server.root}`);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
