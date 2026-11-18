-- Slice 3A carry-over C1 pgTAP (migration 026; Supabase advisor unindexed_foreign_keys).
-- Every foreign key in public must have a covering index whose leading columns equal the FK columns in the FK's
-- order. A partial index only counts when its predicate is nothing but `<fk column> IS NOT NULL` (an equality
-- lookup implies that, so FK checks can still use it). Synthetic only; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

create schema tests;
create function tests.uncovered_fks() returns setof text language sql as $$
  select c.conrelid::regclass::text || '.' || c.conname
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace and n.nspname = 'public'
   where c.contype = 'f'
     and not exists (
       select 1
         from pg_index i
        where i.indrelid = c.conrelid
          and i.indisvalid
          and i.indnkeyatts >= cardinality(c.conkey)
          and (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] = c.conkey
          and (i.indpred is null
               or btrim(regexp_replace(
                    regexp_replace(pg_get_expr(i.indpred, i.indrelid),
                      '(' || (select string_agg(a.attname::text, '|') from pg_attribute a
                               where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) || ') IS NOT NULL', '', 'g'),
                    '[() ]|AND', '', 'g')) = ''))
   order by 1
$$;

select is((select count(*)::int from tests.uncovered_fks()), 0, 'every FK in public has a covering index in FK column order');

select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'service_import_rows_batch_id_company_id_idx'
                   and indexdef like '%(batch_id, company_id)%'), 'C1: service_import_rows (batch_id, company_id) is indexed in FK order');
select ok(not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'service_import_rows_company_id_batch_idx'),
          'C1: the redundant company_id, batch_id index is gone');
select ok(exists (select 1 from pg_indexes where indexname = 'service_import_rows_company_id_idx'),
          'C1: the company_id FK on service_import_rows keeps a cover after the redundant index is dropped');
select ok(exists (select 1 from pg_indexes where indexname = 'driver_licences_evidence_file_id_idx')
          and exists (select 1 from pg_indexes where indexname = 'service_records_evidence_file_id_idx'),
          'C1: the two evidence_file_id FKs found by the audit are indexed');

-- The checker can fail: a composite FK with only a reversed-order index is reported, and clears once indexed in order.
create table public.fkc_parent (a int, b int, unique (a, b));
create table public.fkc_child (id int, a int, b int, foreign key (a, b) references public.fkc_parent (a, b));
create index fkc_child_b_a_idx on public.fkc_child (b, a);
select is((select array_agg(x) from tests.uncovered_fks() x), array['fkc_child.fkc_child_a_b_fkey'],
          'checker flags a composite FK whose index has the columns in the wrong order');
create index fkc_child_a_b_idx on public.fkc_child (a, b);
select is((select count(*)::int from tests.uncovered_fks()), 0, 'checker clears once the index is in FK column order');
drop index public.fkc_child_a_b_idx;
create index fkc_child_a_b_partial_idx on public.fkc_child (a, b) where id > 0;
select is((select count(*)::int from tests.uncovered_fks()), 1, 'checker does not accept a partial index with a real predicate');

select * from finish();
rollback;
