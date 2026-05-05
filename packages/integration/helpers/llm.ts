import type { LLMProvider } from '@equationalapplications/core-llm-wiki';

export function stubLLM(): LLMProvider {
  return { generateText: async () => '{}' };
}

export function scriptedLLM(
  responses: string[],
  embedFn?: (text: string) => Promise<number[]>
): LLMProvider {
  let callIndex = 0;
  return {
    generateText: async () => {
      const response = responses[callIndex++];
      if (response === undefined) {
        throw new Error(`Unexpected LLM call at index ${callIndex - 1} (script has ${responses.length} entries)`);
      }
      return response;
    },
    embed: embedFn,
  };
}

export function keywordEmbed(text: string): number[] {
  if (text.includes('apple')) return [1, 0, 0];
  if (text.includes('car') || text.includes('vehicle')) return [0, 1, 0];
  return [0, 0, 1];
}
