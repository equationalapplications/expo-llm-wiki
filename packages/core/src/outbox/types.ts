export interface WikiOutboxEvent<T = unknown> {
  id: string;
  entity_id: string;
  table_name: string;
  record_id: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  payload: T;
  created_at: number;
}
