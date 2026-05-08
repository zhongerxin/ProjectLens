#!/usr/bin/env node
import readline from "node:readline";
import { startProjectTreeServer, stopProjectTreeServer, getProjectRoot } from "./web-server.js";

const TOOLS = [
  {
    name: "project_tree_start",
    description: "Start the local project tree selector web app and return the in-app-browser URL.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          description: "Optional localhost port. Use 0 or omit to choose a free port."
        },
        root: {
          type: "string",
          description: "Optional absolute project root to browse. Use the current Codex workspace path for home-local installs."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "project_tree_status",
    description: "Return the current project tree selector server status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "project_tree_stop",
    description: "Stop the local project tree selector web app.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
];

let currentServer = null;
let messageQueue = Promise.resolve();

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  messageQueue = messageQueue.then(() => handleMessage(line));
});

process.on("SIGINT", async () => {
  await stopProjectTreeServer(currentServer);
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await stopProjectTreeServer(currentServer);
  process.exit(0);
});

async function handleMessage(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeError(null, -32700, "Parse error");
    return;
  }

  if (!Object.hasOwn(message, "id")) {
    return;
  }

  try {
    const result = await routeMethod(message.method, message.params ?? {});
    writeResponse(message.id, result);
  } catch (error) {
    writeError(message.id, error.code ?? -32603, error.message ?? "Internal error");
  }
}

async function routeMethod(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "project-tree-selector",
          version: "0.1.0"
        }
      };
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(params);
    case "ping":
      return {};
    default:
      throw mcpError(-32601, `Method not found: ${method}`);
  }
}

async function callTool(params) {
  const { name, arguments: args = {} } = params;
  if (name === "project_tree_start") {
    currentServer = await startProjectTreeServer({
      existing: currentServer,
      port: args.port ?? Number(process.env.PROJECT_TREE_PORT || 0),
      root: args.root ?? null
    });
    return toolResult({
      ok: true,
      url: currentServer.url,
      root: currentServer.root,
      message: "Open this URL in Codex's in-app browser."
    });
  }

  if (name === "project_tree_status") {
    return toolResult({
      ok: true,
      running: Boolean(currentServer),
      url: currentServer?.url ?? null,
      root: currentServer?.root ?? getProjectRoot()
    });
  }

  if (name === "project_tree_stop") {
    await stopProjectTreeServer(currentServer);
    currentServer = null;
    return toolResult({ ok: true, running: false });
  }

  throw mcpError(-32602, `Unknown tool: ${name}`);
}

function toolResult(payload, isError = false) {
  return {
    isError,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload
  };
}

function writeResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function mcpError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
