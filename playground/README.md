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

Open [http://localhost:5173](http://localhost:5173) and configure your LLM provider — either Anthropic or an OpenAI-compatible endpoint.

## Architecture

```
src/
  lib/
    sqlJsAdapter.ts        # sql.js → SQLiteAdapter bridge
    anthropicProvider.ts   # Anthropic (Claude) LLM provider
    openaiCompatProvider.ts # OpenAI-compatible LLM provider
  components/
    ReadTab.tsx          # useMemoryRead demo
    WriteTab.tsx         # useWikiWrite demo
    IngestTab.tsx        # useWikiIngest demo
    MaintenanceTab.tsx   # useWikiMaintenance + useWikiForget demo
    ExportTab.tsx        # useWikiExport demo
    CodeBlock.tsx        # Code snippet display with copy-to-clipboard
  App.tsx                # Setup screen + WikiProvider + tab routing
```

## Getting an API Key

**Anthropic:** Get a key at [console.anthropic.com](https://console.anthropic.com).

**OpenAI-compatible:** Use your provider's base URL (e.g. `https://api.openai.com`) and API key. The base URL should be the host root without a trailing `/v1`.

API keys are used only for LLM calls (Librarian/Heal/Ingest) and stored in localStorage.
