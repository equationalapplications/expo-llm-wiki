# @eq/wiki-expo

Expo/React Native adapter for @eq/wiki-core, powered by `expo-sqlite`.

## Features

- **Expo-ready** — Pre-configured for React Native + Expo
- **Built on `expo-sqlite`** — Stable, well-supported SQLite driver
- **React hooks** — `WikiProvider`, `useMemoryRead`, and all other hooks are re-exported directly from `@eq/wiki-expo`

## Installation

```bash
npx expo install expo-sqlite
npm install @eq/wiki-expo
```

## Usage

```typescript
import { createWiki } from '@eq/wiki-expo';
import { openDatabaseSync } from 'expo-sqlite';

const db = openDatabaseSync('wiki.db');

const wiki = createWiki(db, {
  llmProvider: {
    generateText: async ({ systemPrompt, userPrompt }) => {
      // Your LLM call — must return the model output as a string
      return 'Model output';
    },
  },
});

// Initialize tables (call once on app startup)
await wiki.setup();

// Use wiki instance
await wiki.write('user-123', { event_type: 'observation', summary: '...' });
```

## With React

`@eq/wiki-expo` re-exports all hooks and `WikiProvider` from `@eq/wiki-react`:

```typescript
import { WikiProvider } from '@eq/wiki-expo';

<WikiProvider wiki={wiki}>
  <MyApp />
</WikiProvider>
```

Then use hooks in components:

```typescript
import { useMemoryRead } from '@eq/wiki-expo';

export function UserProfile({ userId }: { userId: string }) {
  const { data, isPending } = useMemoryRead(userId, 'preferences');
  
  if (isPending) return <Text>Loading...</Text>;
  return <Text>{data?.facts.map(f => f.title).join(', ')}</Text>;
}
```

## License

MIT
