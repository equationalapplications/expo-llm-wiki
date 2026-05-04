# @equationalapplications/expo-llm-wiki

Expo/React Native adapter for @equationalapplications/core-llm-wiki, powered by `expo-sqlite`.

> Inspired by [Andrej Karpathy's LLM Wiki memory spec](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## Features

- **Expo-ready** — Pre-configured for React Native + Expo
- **Built on `expo-sqlite`** — Stable, well-supported SQLite driver
- **React hooks** — `WikiProvider`, `useMemoryRead`, and all other hooks are re-exported directly from `@equationalapplications/expo-llm-wiki`

## Installation

```bash
npx expo install expo-sqlite
npm install @equationalapplications/expo-llm-wiki
```

## Usage

```typescript
import { createWiki } from '@equationalapplications/expo-llm-wiki';
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

`@equationalapplications/expo-llm-wiki` re-exports all hooks and `WikiProvider` from `@equationalapplications/react-llm-wiki`:

```typescript
import { WikiProvider } from '@equationalapplications/expo-llm-wiki';

<WikiProvider wiki={wiki}>
  <MyApp />
</WikiProvider>
```

Then use hooks in components:

```typescript
import { useMemoryRead } from '@equationalapplications/expo-llm-wiki';

export function UserProfile({ userId }: { userId: string }) {
  const { data, isPending } = useMemoryRead(userId, 'preferences');
  
  if (isPending) return <Text>Loading...</Text>;
  return <Text>{data?.facts.map(f => f.title).join(', ')}</Text>;
}
```

## License

MIT
