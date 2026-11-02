---
title: Choose a package
description: A quick decision guide for picking the right Core LLM Wiki package for your platform.
sidebar:
  order: 2
---

All three memory packages expose **the same API and the same database schema**. They differ only
in how much platform wiring is done for you.

```text
Are you in Expo / React Native?
 ├─ yes → @equationalapplications/expo-llm-wiki      (adapter + crypto + hooks included)
 └─ no  → Are you using React in the browser?
          ├─ yes → @equationalapplications/react-llm-wiki + sql.js   (hooks included)
          └─ no  → @equationalapplications/core-llm-wiki + a SQLite driver
                    • Node.js:  better-sqlite3
                    • Browser:  sql.js
                    • Anything else: write a 6-method adapter
```

## What each package adds

| | `core-llm-wiki` | `react-llm-wiki` | `expo-llm-wiki` |
|---|:-:|:-:|:-:|
| Memory engine (`WikiMemory`, `createWiki`) | ✅ | ✅ re-exported | ✅ re-exported |
| React hooks + `WikiProvider` | — | ✅ | ✅ re-exported |
| Built-in SQLite adapter | — | — | ✅ `expo-sqlite` |
| Secure random IDs on Hermes | manual | manual | ✅ via `expo-crypto` |

:::tip
`react-llm-wiki` and `expo-llm-wiki` re-export everything from `core-llm-wiki`. Import from a single
package; you don't need to install core separately.
:::

## Supported SQLite drivers

Any driver works if you can wrap it in the six-method
[`SQLiteAdapter`](/expo-llm-wiki/guides/sqlite-adapter/) interface. Here are the ones we document:

| Platform | Driver | Notes |
|---|---|---|
| Expo / React Native | `expo-sqlite` | The adapter is built in. Install with `npx expo install`. |
| Node.js | `better-sqlite3` | Synchronous and fast. A good default for servers and scripts. |
| Browser | `sql.js` (WebAssembly) | Ships without FTS5, so keyword search uses the in-memory MiniSearch index. |

The keyword-index backend (FTS5 or MiniSearch) is detected automatically at `setup()`. See
[Retrieval](/expo-llm-wiki/concepts/retrieval/#keyword-index-backends).
