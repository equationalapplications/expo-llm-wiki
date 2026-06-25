import { getRandomValues } from 'expo-crypto';
import { configureRandomSource } from '@equationalapplications/core-llm-wiki';

// Install expo-crypto as the random source for Hermes / React Native, where
// the global `crypto` API is absent. Runs once at module load — any import of
// `@equationalapplications/expo-llm-wiki` or its `/factory` subpath activates it.
configureRandomSource(getRandomValues);
