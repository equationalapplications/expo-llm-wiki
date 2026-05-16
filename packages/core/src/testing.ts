/**
 * Escape-hatch entry for tests: service classes and `WikiMemoryTestAccess`
 * for typed spies/mocks. Not part of the supported runtime consumer API.
 */
export type { WikiMemoryTestAccess } from './WikiMemory';
export { EmbeddingService } from './services/EmbeddingService';
export { ImportExportService } from './services/ImportExportService';
export { IngestionService } from './services/IngestionService';
export { MaintenanceService } from './services/MaintenanceService';
export { RetrievalService } from './services/RetrievalService';
export { SearchService } from './services/SearchService';
export { JobManager } from './services/JobManager';
export { WriteService } from './services/WriteService';
// Re-export types for test typed spies/mocks
export type { SearchService as SearchServiceType } from './services/SearchService';
export type { JobManager as JobManagerType } from './services/JobManager';
