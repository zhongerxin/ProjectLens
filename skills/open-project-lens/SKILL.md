---
name: open-project-lens
description: Open the current project folder in Project Lens, a Codex in-app-browser project tree powered by @pierre/trees.
---

# Open Project Lens

Use this skill when the user asks to browse, select, inspect, or open the current project as a file tree in Codex's in-app browser.

Workflow:

1. Call the `project_lens_start` MCP tool. When this plugin is installed as a home-local plugin, pass the current workspace root as the `root` argument.
2. Take the returned `url`.
3. Use Codex's Browser Use / in-app-browser capability to navigate to that URL.
4. Tell the user the local URL and project root.

Notes:

- The web app reads files from the project root that contains this plugin.
- The browser cannot read local files by itself; the MCP server starts a localhost HTTP server that exposes a read-only tree and file preview API.
- If `project_lens_start` reports that the app is not built, run `npm install && npm run build` from the plugin directory, then call the tool again.
