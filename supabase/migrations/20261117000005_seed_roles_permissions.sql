-- Phase 1A — DEC-23 permission matrix as configuration data (PRD §4.2, Approved 2026-11-17).
-- Roles are system-defined (company_id NULL). A grant exists where the matrix cell is not "—".
-- Scope (Own/Branch/All) is realised by user_roles.branch_id (NULL = All) plus row-level
-- ownership checks in later phases; it is NOT a column on role_permissions (DB §3).
-- System admin deliberately has NO evidence/report/licence permissions but has audit.view.
-- Every grant remains subject to DEC-24 segregation of duties (enforced in later slices).

insert into public.roles (name, description) values
  ('driver',            'Driver'),
  ('supervisor',        'Supervisor'),
  ('fleet_admin',       'Fleet administrator'),
  ('maintenance_admin', 'Maintenance administrator'),
  ('branch_manager',    'Branch manager (Operations manager, DEC-32)'),
  ('senior_management', 'Senior management (view-only)'),
  ('system_admin',      'System administrator')
on conflict do nothing;

insert into public.permissions (permission_key, description) values
  ('inspection.submit',                'Submit inspections'),
  ('allocation.manage',                'Manage allocations'),
  ('odometer.exception.review',        'Review odometer exceptions'),
  ('odometer.exception.approve',       'Approve standard odometer exceptions'),
  ('odometer.correction.approve',      'Approve odometer corrections'),
  ('odometer.adjustment.approve',      'Approve odometer adjustments'),
  ('odometer.no_photo.approve',        'Approve no-photo odometer exceptions (DEC-03)'),
  ('service.record.create',            'Create service records'),
  ('service.record.verify',            'Verify service records'),
  ('service.config.manage',            'Manage service configuration'),
  ('vehicle.manage',                   'Manage vehicles'),
  ('vehicle.transfer.approve',         'Approve vehicle transfers (DEC-31)'),
  ('driver.manage',                    'Manage drivers'),
  ('driver.licence.view_sensitive',    'View sensitive licence details'),
  ('incident.record',                  'Record incidents'),
  ('incident.investigate_close',       'Investigate and close incidents'),
  ('evidence.view',                    'View evidence'),
  ('reports.view',                     'View reports'),
  ('settings.validation.manage',       'Manage validation settings'),
  ('users.roles.manage',               'Manage users and role assignments'),
  ('audit.view',                       'View the audit log')
on conflict do nothing;

with matrix(role_name, permission_key) as (values
  -- driver
  ('driver','inspection.submit'),('driver','driver.licence.view_sensitive'),('driver','incident.record'),('driver','evidence.view'),
  -- supervisor
  ('supervisor','inspection.submit'),('supervisor','allocation.manage'),('supervisor','odometer.exception.review'),
  ('supervisor','odometer.exception.approve'),('supervisor','odometer.no_photo.approve'),
  ('supervisor','driver.licence.view_sensitive'),('supervisor','incident.record'),
  ('supervisor','incident.investigate_close'),('supervisor','evidence.view'),('supervisor','reports.view'),
  -- fleet admin
  ('fleet_admin','allocation.manage'),('fleet_admin','odometer.exception.review'),('fleet_admin','odometer.exception.approve'),
  ('fleet_admin','odometer.correction.approve'),('fleet_admin','odometer.adjustment.approve'),('fleet_admin','odometer.no_photo.approve'),
  ('fleet_admin','service.record.create'),('fleet_admin','service.record.verify'),('fleet_admin','service.config.manage'),
  ('fleet_admin','vehicle.manage'),('fleet_admin','vehicle.transfer.approve'),('fleet_admin','driver.manage'),
  ('fleet_admin','driver.licence.view_sensitive'),('fleet_admin','incident.record'),('fleet_admin','incident.investigate_close'),
  ('fleet_admin','evidence.view'),('fleet_admin','reports.view'),('fleet_admin','settings.validation.manage'),('fleet_admin','audit.view'),
  -- maintenance admin
  ('maintenance_admin','service.record.create'),('maintenance_admin','service.record.verify'),
  ('maintenance_admin','evidence.view'),('maintenance_admin','reports.view'),
  -- branch manager
  ('branch_manager','allocation.manage'),('branch_manager','odometer.exception.review'),('branch_manager','odometer.exception.approve'),
  ('branch_manager','odometer.correction.approve'),('branch_manager','odometer.no_photo.approve'),('branch_manager','driver.manage'),
  ('branch_manager','driver.licence.view_sensitive'),('branch_manager','incident.record'),('branch_manager','incident.investigate_close'),
  ('branch_manager','evidence.view'),('branch_manager','reports.view'),
  -- senior management (view-only)
  ('senior_management','evidence.view'),('senior_management','reports.view'),('senior_management','audit.view'),
  -- system admin: users/settings + audit only
  ('system_admin','settings.validation.manage'),('system_admin','users.roles.manage'),('system_admin','audit.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from matrix m
join public.roles r on r.name = m.role_name and r.company_id is null
join public.permissions p on p.permission_key = m.permission_key
on conflict do nothing;
