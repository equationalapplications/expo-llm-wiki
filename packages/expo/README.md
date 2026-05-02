# @eq/wiki-expo

Expo/React Native adapter for @eq/wiki-core, powered by `expo-sqlite`.

## Features

- **Expo-ready** — Pre-configured for React Native + Expo
- **Built on `expo-sqlite`** — Stable, well-supported SQLite driver
- **React hooks** — Use `@eq/wiki-react` for React component integration

## Installation

```bash
npm install @eq/wiki-expo expo-sqlite
```

## Usage

```typescript
import { createWiki } from '@eq/wiki-expo';
import { openDatabaseSync } from 'expo-sqlite';

const db = openDatabaseSync('wiki.db');

const wiki = createWiki(db, {
  llmProvider: {
    generateText: async ({ systemPrompt, userPrompt }) => {
      // Your LLM call
    },
  },
});

// Use wiki instance
await wiki.write('user-123', { type: 'observation', summary: '...' });
```

## With React

```typescript
import { WikiProvider } from '@eq/wiki-react';

<WikiProvider wiki={wiki}>
  <MyApp />
</WikiProvider>
```

Then use hooks in components:

```typescript
import { useMemoryRead } from '@eq/wiki-react';

export function UserProfile({ userId }: { userId: string }) {
  const { data, isPending } = useMemoryRead(userId, 'preferences');
  
  if (isPending) return <Text>Loading...</Text>;
  return <Text>{data?.facts.map(f => f.title).join(', ')}</Text>;
}
```

## License

MIT
