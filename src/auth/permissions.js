'use strict';

/**
 * Permission model.
 *
 * `bulk_whatsapp_reminders` is the feature switch: without it a user cannot
 * see the Bulk WhatsApp Reminders pages at all, regardless of role. The more
 * specific permissions control individual actions. Role defaults can be
 * overridden per user in `user_permissions` (granted = true/false).
 */
const PERMISSIONS = Object.freeze({
  ACCESS: 'bulk_whatsapp_reminders',
  UPLOAD: 'bulk_whatsapp_reminders.upload',
  SEND: 'bulk_whatsapp_reminders.send',
  CONTROL: 'bulk_whatsapp_reminders.control', // pause / resume / cancel
  RETRY: 'bulk_whatsapp_reminders.retry',
  EXPORT: 'bulk_whatsapp_reminders.export',
  VIEW_ALL: 'bulk_whatsapp_reminders.view_all', // otherwise: own batches + assigned customers only
  EDIT_BATCH_TEMPLATE: 'bulk_whatsapp_reminders.edit_batch_template',
  OVERRIDE_DUPLICATES: 'bulk_whatsapp_reminders.override_duplicates',
  MANAGE_SETTINGS: 'whatsapp_settings.manage', // global template, opt-outs
  VIEW_AUDIT: 'audit_logs.view',
  MANAGE_USERS: 'users.manage',
});

const P = PERMISSIONS;

const ROLE_DEFAULTS = Object.freeze({
  admin: Object.values(P),
  main_head: [P.ACCESS, P.UPLOAD, P.SEND, P.CONTROL, P.RETRY, P.EXPORT, P.VIEW_ALL, P.EDIT_BATCH_TEMPLATE],
  // Employees can view reminder status for their assigned customers. Sending
  // (P.SEND + P.UPLOAD) can be granted per user; settings can never be.
  employee: [P.ACCESS],
});

const ROLES = Object.keys(ROLE_DEFAULTS);
const NEVER_FOR_EMPLOYEE = new Set([P.MANAGE_SETTINGS, P.MANAGE_USERS, P.VIEW_AUDIT, P.VIEW_ALL]);

function effectivePermissions(role, overrides = []) {
  const set = new Set(ROLE_DEFAULTS[role] || []);
  for (const o of overrides) {
    if (o.granted) set.add(o.permission);
    else set.delete(o.permission);
  }
  if (role === 'employee') for (const p of NEVER_FOR_EMPLOYEE) set.delete(p);
  // Any bulk permission is meaningless without the feature switch.
  if (!set.has(P.ACCESS)) for (const p of [...set]) if (p.startsWith('bulk_whatsapp_reminders.')) set.delete(p);
  return set;
}

module.exports = { PERMISSIONS, ROLE_DEFAULTS, ROLES, effectivePermissions };
