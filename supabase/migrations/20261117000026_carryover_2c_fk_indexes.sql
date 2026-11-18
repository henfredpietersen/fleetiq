-- 026 — Carry-over C1 from the 2C review (Supabase performance advisor: unindexed_foreign_keys). Never edits 024.
-- The composite FK service_import_rows (batch_id, company_id) -> service_import_batches had no covering index in FK
-- column order. Add it, and drop service_import_rows_company_id_batch_idx, which it makes redundant (RLS filters by
-- company_id through the batch and every query is by batch).
-- Auditing every FK in public for this also found two single-column FKs with no index at all
-- (driver_licences / service_records .evidence_file_id -> evidence_files); they are indexed here so the new
-- FK-coverage test (phase3a_carryover_fk_index.test.sql) passes for the whole schema, not just the one the review named.

create index service_import_rows_batch_id_company_id_idx on public.service_import_rows (batch_id, company_id);
drop index public.service_import_rows_company_id_batch_idx;
-- ...but that index was also the only cover for the single-column FK service_import_rows.company_id -> companies, so
-- the FK-coverage rule needs a narrow replacement for it (the dropped index was (company_id, batch_id) wide).
create index service_import_rows_company_id_idx on public.service_import_rows (company_id);

create index driver_licences_evidence_file_id_idx on public.driver_licences (evidence_file_id);
create index service_records_evidence_file_id_idx on public.service_records (evidence_file_id);
