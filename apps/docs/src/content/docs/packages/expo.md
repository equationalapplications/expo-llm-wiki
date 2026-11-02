---
title: expo-llm-wiki
description: LLM memory for Expo and React Native, with the expo-sqlite adapter, secure IDs, and React hooks built in.
sidebar:
  order: 2
---

`@equationalapplications/expo-llm-wiki` · [npm](https://www.npmjs.com/package/@equationalapplications/expo-llm-wiki) · [source](https://github.com/equationalapplications/expo-llm-wiki/tree/main/packages/expo)

```bash
npx expo install expo-sqlite expo-crypto
npm install @equationalapplications/expo-llm-wiki
```

## What it adds on top of core

- **`createWiki(db, options)`** takes an `expo-sqlite` `SQLiteDatabase` directly. You don't
  write an adapter.
- **Secure IDs on Hermes.** `expo-crypto`'s `getRandomValues` is registered when the package
  is imported, from the main entry or the `/factory` subpath.
- **Every React hook** and `WikiProvider` from `react-llm-wiki`, re-exported.
- **Everything from core**, re-exported, so you only need one import path.

```ts
import * as SQLite from 'expo-sqlite';
import { createWiki, WikiProvider, useMemoryRead, formatContext } from '@equationalapplications/expo-llm-wiki';

const db = await SQLite.openDatabaseAsync('app.db'); // or openDatabaseSync
const wiki = createWiki(db, { llmProvider });
await wiki.setup();
```

## Peer dependencies

| Package | Range |
|---|---|
| `expo-sqlite` | `^14 \|\| ^15 \|\| ^55 \|\| ^56 \|\| ^57 \|\| ^58` |
| `expo-crypto` | matching your Expo SDK |
| `react` | `>=17` (optional, needed for hooks) |

Start with the [Expo quickstart](/expo-llm-wiki/start/quickstart-expo/).
