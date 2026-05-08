import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { createReadStream, existsSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const DIST_ROOT = path.join(PLUGIN_ROOT, "dist");
const REPO_LOCAL_PROJECT_ROOT = path.resolve(PLUGIN_ROOT, "..", "..");

const SKIPPED_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".DS_Store",
  ".venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache"
]);

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"]
]);

export function getProjectRoot(rootOverride = null) {
  return rootOverride ? path.resolve(rootOverride) : process.env.PROJECT_TREE_ROOT || REPO_LOCAL_PROJECT_ROOT;
}

export async function startProjectTreeServer({ existing = null, port = 0, root = null } = {}) {
  if (existing) {
    return existing;
  }

  const projectRoot = getProjectRoot(root);

  if (!existsSync(path.join(DIST_ROOT, "index.html"))) {
    throw new Error("Web app is not built. Run `npm install && npm run build` in the plugin directory first.");
  }

  const events = createFileEventHub();
  const watcher = startProjectWatcher(projectRoot, events);
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, projectRoot, events);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error.message ?? "Internal server error"
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  return { events, server, url, root: projectRoot, watcher };
}

export async function stopProjectTreeServer(handle) {
  if (!handle) {
    return;
  }
  handle.events?.close();
  await handle.watcher?.close();
  if (handle.server) {
    await new Promise((resolve) => handle.server.close(resolve));
  }
}

async function handleRequest(request, response, root, events) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/tree") {
    const tree = await buildTreePayload(root);
    sendJson(response, 200, tree);
    return;
  }

  if (url.pathname === "/api/file") {
    const filePath = url.searchParams.get("path") ?? "";
    const payload = await readProjectFile(root, filePath);
    sendJson(response, 200, payload);
    return;
  }

  if (url.pathname === "/api/events") {
    events.addClient(response);
    return;
  }

  await serveStatic(url.pathname, response);
}

function createFileEventHub() {
  const clients = new Set();
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      client.write(": heartbeat\n\n");
    }
  }, 25000);

  return {
    addClient(response) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      response.write("retry: 1000\n\n");
      clients.add(response);
      response.on("close", () => clients.delete(response));
    },
    broadcast(payload) {
      const message = `data: ${JSON.stringify(payload)}\n\n`;
      for (const client of clients) {
        client.write(message);
      }
    },
    close() {
      clearInterval(heartbeat);
      for (const client of clients) {
        client.end();
      }
      clients.clear();
    }
  };
}

function startProjectWatcher(root, events) {
  let pendingPayload = null;
  let debounceTimer = null;

  const watcher = watch(root, { recursive: true }, (eventType, filename) => {
    const relativePath = normalizeRelativePath(filename?.toString() ?? "");
    if (!relativePath || relativePath === "." || shouldSkipRelativePath(relativePath)) {
      return;
    }

    pendingPayload = {
      event: eventType,
      path: relativePath,
      timestamp: new Date().toISOString(),
      treeChanged: eventType === "rename",
      type: "fs"
    };
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      events.broadcast(pendingPayload);
      pendingPayload = null;
    }, 120);
  });

  queueMicrotask(() => {
    events.broadcast({
      timestamp: new Date().toISOString(),
      type: "watcher-ready"
    });
  });

  watcher.on("error", (error) => {
    events.broadcast({
      error: error.message ?? "File watcher error",
      timestamp: new Date().toISOString(),
      type: "watcher-error"
    });
  });

  return {
    async close() {
      clearTimeout(debounceTimer);
      watcher.close();
    }
  };
}

async function buildTreePayload(root) {
  const paths = [];
  await walkProject(root, "", paths);

  const gitStatus = readGitStatus(root);
  for (const entry of gitStatus) {
    if (entry.status === "deleted" && !paths.includes(entry.path)) {
      paths.push(entry.path);
    }
  }

  paths.sort((left, right) => left.localeCompare(right));

  return {
    ok: true,
    root,
    paths,
    gitStatus,
    generatedAt: new Date().toISOString()
  };
}

async function walkProject(absoluteDir, relativeDir, paths) {
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) {
      return left.isDirectory() ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  for (const entry of entries) {
    if (SKIPPED_NAMES.has(entry.name)) {
      continue;
    }

    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const absolutePath = path.join(absoluteDir, entry.name);

    if (entry.isDirectory()) {
      paths.push(`${relativePath}/`);
      await walkProject(absolutePath, relativePath, paths);
      continue;
    }

    if (entry.isFile() || entry.isSymbolicLink()) {
      paths.push(relativePath);
    }
  }
}

function readGitStatus(root) {
  const result = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  const records = result.stdout.split("\0").filter(Boolean);
  const statuses = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2);
    const filePath = normalizeRelativePath(record.slice(3));
    const status = mapGitStatus(code);

    if (!filePath || !status) {
      continue;
    }

    if (shouldSkipRelativePath(filePath)) {
      continue;
    }

    statuses.push({ path: filePath, status });

    if (code.includes("R") || code.includes("C")) {
      index += 1;
    }
  }

  return statuses;
}

function shouldSkipRelativePath(relativePath) {
  return relativePath.split("/").some((segment) => SKIPPED_NAMES.has(segment));
}

function mapGitStatus(code) {
  if (code === "??") return "untracked";
  if (code === "!!") return "ignored";
  if (code.includes("R")) return "renamed";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.trim()) return "modified";
  return null;
}

async function readProjectFile(root, relativePath) {
  const cleanPath = normalizeRelativePath(relativePath);
  const absolutePath = path.resolve(root, cleanPath);

  if (!absolutePath.startsWith(`${root}${path.sep}`) && absolutePath !== root) {
    return { ok: false, error: "Path is outside the project root." };
  }

  const fileStat = await lstat(absolutePath);
  if (fileStat.isDirectory()) {
    return {
      ok: true,
      path: cleanPath,
      isDirectory: true
    };
  }

  const sizeLimit = 512 * 1024;
  if (fileStat.size > sizeLimit) {
    return {
      ok: true,
      path: cleanPath,
      isDirectory: false,
      isBinary: false,
      truncated: true,
      size: fileStat.size,
      content: `File is ${fileStat.size} bytes; preview is limited to ${sizeLimit} bytes.`
    };
  }

  const buffer = await readFile(absolutePath);
  const isBinary = buffer.includes(0);

  return {
    ok: true,
    path: cleanPath,
    isDirectory: false,
    isBinary,
    size: fileStat.size,
    content: isBinary ? "Binary file preview is not available." : buffer.toString("utf8")
  };
}

async function serveStatic(requestPath, response) {
  const requested = requestPath === "/" ? "/index.html" : requestPath;
  let absolutePath = path.resolve(DIST_ROOT, `.${requested}`);

  if (!absolutePath.startsWith(`${DIST_ROOT}${path.sep}`)) {
    sendJson(response, 403, { ok: false, error: "Forbidden" });
    return;
  }

  try {
    const fileStat = await stat(absolutePath);
    if (fileStat.isDirectory()) {
      absolutePath = path.join(absolutePath, "index.html");
    }
  } catch {
    absolutePath = path.join(DIST_ROOT, "index.html");
  }

  const extension = path.extname(absolutePath);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES.get(extension) ?? "application/octet-stream"
  });
  createReadStream(absolutePath).pipe(response);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function normalizeRelativePath(input) {
  return input.replaceAll("\\", "/").replace(/^\/+/, "");
}
