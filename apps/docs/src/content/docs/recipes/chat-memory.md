---
title: Chat assistant with long-term memory
description: A complete chat loop that remembers the user across sessions — read before answering, write after.
sidebar:
  order: 1
---

**Goal:** a chat assistant that remembers facts about the user from earlier conversations.

**Pattern:** for every turn, **read** relevant memory, **answer** with it in the system prompt,
then **write** what you learned.

```ts title="chat.ts"
import { formatContext, type WikiMemory } from '@equationalapplications/core-llm-wiki';

export async function chatTurn(wiki: WikiMemory, userId: string, userMessage: string) {
  // 1. Recall
  const memory = await wiki.read(userId, userMessage, { maxResults: 8, tokenBudget: 1200 });
  const context = formatContext(memory, { maxEvents: 5 });

  // 2. Answer
  const reply = await callModel({
    system: `You are a friendly assistant. What you remember about the user:\n\n${context}`,
    user: userMessage,
  });

  // 3. Remember (don't block the reply on it)
  void wiki.write(userId, { event_type: 'observation', summary: `User said: ${userMessage}` });
  void wiki.write(userId, { event_type: 'action', summary: `Assistant replied: ${reply.slice(0, 500)}` });

  return reply;
}
```

When maintenance runs (call `runPendingMaintenance()`, or set `maintenance: 'auto'` for every 20 events), the librarian turns these into facts such as *"Prefers vegetarian recipes"* and
tasks such as *"Remind the user about the dentist on Friday"*.

## In an Expo screen

```tsx
import { useState } from 'react';
import { useWiki, useEntityStatus } from '@equationalapplications/expo-llm-wiki';
import { chatTurn } from './chat';

export function ChatScreen({ userId }: { userId: string }) {
  const wiki = useWiki();
  const { librarian } = useEntityStatus(userId);
  const [messages, setMessages] = useState<{ role: string; text: string }[]>([]);

  const send = async (text: string) => {
    setMessages((m) => [...m, { role: 'user', text }]);
    const reply = await chatTurn(wiki, userId, text);
    setMessages((m) => [...m, { role: 'assistant', text: reply }]);
  };

  return (
    <>
      {librarian && <Text style={{ opacity: 0.6 }}>Updating memory…</Text>}
      {/* render messages + input that calls send() */}
    </>
  );
}
```

## Variations

- **Summarize rather than log raw messages.** Write one short `observation` per meaningful
  statement instead of every message. You get fewer events and better facts.
- **Let users correct memory.** Show `read(userId, '')` (the most recent facts) in a settings
  screen with a delete button that calls `forget({ entryId })`.
- **Keep history when facts change.** The default `'ops'` librarian strategy supersedes "lives in
  Seattle" with "moved to SF" instead of overwriting it.

:::caution
Messages from users flow into LLM prompts. Treat librarian output as untrusted input. See
[Security → prompt injection](/expo-llm-wiki/project/security/#prompt-injection-trust-boundary).
:::
