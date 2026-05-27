# LLM Wiki Playground

An interactive playground for learning and exploring the `@equationalapplications/react-llm-wiki` package.

## Features

- **Write** — Record observations with `useWikiWrite`
- **Read** — Query memories semantically with `useMemoryRead`
- **Ingest** — Parse documents into facts with `useWikiIngest`
- **Maintenance** — Run Librarian, Heal, Prune jobs with `useWikiMaintenance`
- **Export** — Dump and inspect memory with `useWikiExport`

All data stays in-browser using sql.js (WebAssembly SQLite) — no backend required.

## Setup

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) and enter your Anthropic API key.

## Architecture

```
src/
  lib/
    sqlJsAdapter.ts      # sql.js → SQLiteAdapter bridge
    anthropicProvider.ts # Claude Haiku LLM provider
  components/
    ReadTab.tsx          # useMemoryRead demo
    WriteTab.tsx         # useWikiWrite demo
    IngestTab.tsx        # useWikiIngest demo
    MaintenanceTab.tsx   # useWikiMaintenance + useWikiForget demo
    ExportTab.tsx        # useWikiExport demo
    CodeBlock.tsx        # Syntax-highlighted code snippets
  App.tsx                # Setup screen + WikiProvider + tab routing
```

## Getting an API Key

Get an Anthropic API key at [console.anthropic.com](https://console.anthropic.com).
The key is used only for LLM calls (Librarian/Heal/Ingest) and stored in localStorage.
