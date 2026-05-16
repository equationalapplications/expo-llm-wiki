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
export { WriteService } from './services/WriteService';
