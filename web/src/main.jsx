import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FileTree, useFileTree, useFileTreeSelection } from "@pierre/trees/react";
import hljs from "highlight.js/lib/common";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./styles.css";

function App() {
  const workspaceRef = useRef(null);
  const [treeData, setTreeData] = useState(null);
  const [selectedPath, setSelectedPath] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [treeWidth, setTreeWidth] = useState(340);
  const selectedPathRef = useRef(null);

  const loadTree = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    if (!quiet) setError(null);
    try {
      const response = await fetch("/api/tree");
      const payload = await response.json();
      if (!payload.ok) throw new Error(payload.error || "Failed to load tree");
      setTreeData(payload);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  const loadPreview = useCallback(async (pathToPreview, { signal } = {}) => {
    const response = await fetch(`/api/file?path=${encodeURIComponent(pathToPreview)}`, { signal });
    const payload = await response.json();
    if (!signal?.aborted) setPreview(payload);
  }, []);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    if (!selectedPath) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    loadPreview(selectedPath, { signal: controller.signal }).catch((previewError) => {
      if (!cancelled) setPreview({ ok: false, error: previewError.message });
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [loadPreview, selectedPath]);

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      return undefined;
    }

    let treeRefreshTimer = null;
    const source = new EventSource("/api/events");
    source.onmessage = (message) => {
      let payload;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }

      if (payload.type === "watcher-error") {
        setError(payload.error);
        return;
      }

      if (payload.type === "watcher-ready") {
        setError(null);
        return;
      }

      if (payload.type !== "fs") {
        return;
      }

      setError(null);
      clearTimeout(treeRefreshTimer);
      treeRefreshTimer = setTimeout(() => {
        loadTree({ quiet: true });
      }, payload.treeChanged ? 100 : 250);

      const currentSelection = selectedPathRef.current;
      if (currentSelection && isPathAffected(currentSelection, payload.path)) {
        loadPreview(currentSelection).catch((previewError) => {
          setPreview({ ok: false, error: previewError.message });
        });
      }
    };

    source.onerror = () => {
      setError("File watcher connection interrupted; retrying...");
    };

    return () => {
      clearTimeout(treeRefreshTimer);
      source.close();
    };
  }, [loadPreview, loadTree]);

  const clampTreeWidth = useCallback((nextWidth) => {
    const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const maxWidth = Math.max(340, Math.min(720, workspaceWidth - 320));
    return Math.round(Math.min(Math.max(nextWidth, 260), maxWidth));
  }, []);

  const startResize = useCallback(
    (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = treeWidth;

      function handlePointerMove(moveEvent) {
        setTreeWidth(clampTreeWidth(startWidth + moveEvent.clientX - startX));
      }

      function handlePointerUp() {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        document.body.classList.remove("is-resizing-tree");
      }

      document.body.classList.add("is-resizing-tree");
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
    },
    [clampTreeWidth, treeWidth]
  );

  function resizeWithKeyboard(event) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setTreeWidth((currentWidth) => clampTreeWidth(currentWidth - 20));
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setTreeWidth((currentWidth) => clampTreeWidth(currentWidth + 20));
    }
  }

  return (
    <main className="app-shell">
      <section
        className="workspace"
        ref={workspaceRef}
        style={{ "--tree-width": `${treeWidth}px` }}
      >
        <div className="tree-panel">
          {loading && <div className="state-text">Loading tree...</div>}
          {error && <div className="state-text error">{error}</div>}
          {treeData && (
            <ProjectTree
              paths={treeData.paths}
              gitStatus={treeData.gitStatus}
              selectedPath={selectedPath}
              onSelect={setSelectedPath}
            />
          )}
        </div>

        <div
          aria-label="Resize file tree"
          aria-orientation="vertical"
          className="resize-handle"
          onKeyDown={resizeWithKeyboard}
          onPointerDown={startResize}
          role="separator"
          tabIndex={0}
          title="Resize file tree"
        />

        <aside className="details-panel">
          <div className="details-body">
            {!selectedPath && <div className="state-text">Select a file or folder.</div>}
            {selectedPath && <Preview path={selectedPath} payload={preview} />}
          </div>
        </aside>
      </section>
    </main>
  );
}

function ProjectTree({ paths, gitStatus, selectedPath, onSelect }) {
  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpansion: 0,
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    flattenEmptyDirectories: true,
    fileTreeSearchMode: "expand-matches",
    search: true,
    stickyFolders: true,
    density: "compact"
  });

  const selectedPaths = useFileTreeSelection(model);

  useEffect(() => {
    onSelect(selectedPaths.at(-1) ?? null);
  }, [onSelect, selectedPaths]);

  return (
    <FileTree
      model={model}
      className="project-tree"
      style={{
        height: "100%",
        "--trees-bg-override": "#ffffff",
        "--trees-selected-bg-override": "#dbeafe",
        "--trees-border-color-override": "#d8dee8"
      }}
    />
  );
}

function Preview({ path, payload }) {
  if (!payload) {
    return <div className="state-text">Loading preview...</div>;
  }

  if (!payload.ok) {
    return <div className="state-text error">{payload.error}</div>;
  }

  if (payload.isDirectory) {
    return <div className="state-text">Folder selected.</div>;
  }

  return <CodePreview content={payload.content ?? ""} isBinary={payload.isBinary} path={path} />;
}

function CodePreview({ content, isBinary, path }) {
  const language = getLanguage(path);

  if (language === "markdown") {
    return (
      <article className="markdown-preview">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </article>
    );
  }

  const lines = content.length > 0 ? content.split("\n") : [""];

  return (
    <div className="code-viewer" data-binary={isBinary ? "true" : "false"} data-language={language ?? "text"}>
      {lines.map((line, index) => (
        <div className="code-line" key={`${index}:${line}`}>
          <span className="line-number">{index + 1}</span>
          <code
            className="line-code"
            dangerouslySetInnerHTML={{ __html: highlightLine(line, language) || " " }}
          />
        </div>
      ))}
    </div>
  );
}

function highlightLine(line, language) {
  if (!language || !hljs.getLanguage(language)) {
    return escapeHtml(line);
  }

  try {
    return hljs.highlight(line, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(line);
  }
}

function getLanguage(path) {
  const extension = path.split(".").pop()?.toLowerCase();
  const name = path.split("/").pop()?.toLowerCase();
  const languageByExtension = {
    bash: "bash",
    cjs: "javascript",
    css: "css",
    html: "xml",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    sh: "bash",
    toml: "ini",
    ts: "typescript",
    tsx: "typescript",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml"
  };

  if (name === "makefile") return "makefile";
  return languageByExtension[extension] ?? null;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

createRoot(document.getElementById("root")).render(<App />);

function isPathAffected(selectedPath, changedPath) {
  return changedPath === selectedPath || changedPath.startsWith(`${selectedPath.replace(/\/$/, "")}/`);
}
