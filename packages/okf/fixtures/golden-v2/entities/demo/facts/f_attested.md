---
type: Attested Computation
title: Monthly revenue
status: stable
generated: { by: "process:cron-nightly", at: "2026-01-01T00:00:00Z" }
runtime: bigquery
parameters: [ { name: month, type: string, required: true } ]
computation: ./queries/monthly_revenue.sql
executor: { resource: "bq://finance-prod", receipt: [job_id, executed_sql, result] }
attester: { resource: "human:controller@finance.example.com" }
sources: [ { resource: "https://example.com/methodology" } ]
id: f_attested
entity_id: demo
confidence: certain
source_type: immutable_document
created_at: 1736899200000
---

# Computation

SELECT SUM(amount) FROM ledger WHERE month = @month;

## Related
