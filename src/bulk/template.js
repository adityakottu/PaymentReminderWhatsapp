'use strict';

/**
 * Minimal, safe message template renderer.
 *
 * Supported syntax (no code execution, no HTML escaping – output is plain text):
 *   {{variable}}
 *   {{#if variable}} ... {{/if}}
 *   {{#if variable}} ... {{else}} ... {{/if}}
 * Blocks may be nested.
 */

const DEFAULT_TEMPLATE = `Hello {{customer_name}},

This is a reminder regarding your pending payment of ₹{{amount_due}}.
{{#if due_date}}
Due Date: {{due_date}}
{{/if}}
Please make the payment at your earliest convenience.
{{#if account_id}}
Loan/Account ID: {{account_id}}
{{/if}}{{#if custom_message}}
{{custom_message}}
{{/if}}
Thank you.`;

const VARIABLES = [
  'customer_name',
  'amount_due',
  'due_date',
  'account_id',
  'installment_number',
  'collector_name',
  'custom_message',
  'phone_number',
];

const MAX_TEMPLATE_LENGTH = 2000;
const TOKEN_RE = /\{\{\s*(#if\s+([a-z_][a-z0-9_]*)|\/if|else|([a-z_][a-z0-9_]*))\s*\}\}/gi;

function parse(template) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(template)) !== null) {
    const top = stack[stack.length - 1];
    const target = top.type === 'if' && top.inElse ? top.elseChildren : top.children;
    if (m.index > last) target.push({ type: 'text', value: template.slice(last, m.index) });
    last = TOKEN_RE.lastIndex;
    if (m[2]) {
      const node = { type: 'if', name: m[2].toLowerCase(), children: [], elseChildren: [], inElse: false };
      target.push(node);
      stack.push(node);
    } else if (m[1].toLowerCase() === '/if') {
      if (top.type !== 'if') throw new TemplateError('Unexpected {{/if}} without a matching {{#if}}');
      stack.pop();
    } else if (m[1].toLowerCase() === 'else') {
      if (top.type !== 'if' || top.inElse) throw new TemplateError('Unexpected {{else}}');
      top.inElse = true;
    } else {
      target.push({ type: 'var', name: m[3].toLowerCase() });
    }
  }
  if (stack.length !== 1) throw new TemplateError('Unclosed {{#if}} block');
  if (last < template.length) root.children.push({ type: 'text', value: template.slice(last) });
  return root;
}

class TemplateError extends Error {}

function renderNodes(nodes, vars) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.value;
    else if (n.type === 'var') out += vars[n.name] === undefined || vars[n.name] === null ? '' : String(vars[n.name]);
    else if (n.type === 'if') {
      const v = vars[n.name];
      const truthy = v !== undefined && v !== null && String(v).trim() !== '';
      out += renderNodes(truthy ? n.children : n.elseChildren, vars);
    }
  }
  return out;
}

function collectVariables(node, set = new Set()) {
  for (const n of node.children || []) {
    if (n.type === 'var') set.add(n.name);
    if (n.type === 'if') {
      set.add(n.name);
      collectVariables({ children: n.children }, set);
      collectVariables({ children: n.elseChildren }, set);
    }
  }
  return set;
}

/** Validate a template; returns { ok, errors, unknownVariables }. */
function validateTemplate(template) {
  const errors = [];
  if (typeof template !== 'string' || template.trim() === '') errors.push('Template cannot be empty');
  else if (template.length > MAX_TEMPLATE_LENGTH) errors.push(`Template is longer than ${MAX_TEMPLATE_LENGTH} characters`);
  let unknownVariables = [];
  if (!errors.length) {
    try {
      const used = collectVariables(parse(template));
      unknownVariables = [...used].filter((v) => !VARIABLES.includes(v));
      if (unknownVariables.length) errors.push(`Unknown placeholder(s): ${unknownVariables.map((v) => `{{${v}}}`).join(', ')}`);
      if (!used.has('customer_name')) errors.push('Template must include {{customer_name}}');
      if (!used.has('amount_due')) errors.push('Template must include {{amount_due}}');
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { ok: errors.length === 0, errors, unknownVariables };
}

function formatAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
}

/** YYYY-MM-DD -> DD-MM-YYYY */
function formatDate(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso);
}

function variablesForRecord(record) {
  return {
    customer_name: record.customer_name,
    amount_due: formatAmount(record.amount_due),
    due_date: formatDate(record.due_date),
    account_id: record.account_id || '',
    installment_number: record.installment_number || '',
    collector_name: record.collector_name || '',
    custom_message: record.custom_message || '',
    phone_number: record.phone_number || '',
  };
}

function renderTemplate(template, vars) {
  const text = renderNodes(parse(template).children, vars);
  // Collapse runs of 3+ newlines left behind by empty conditional blocks.
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function renderForRecord(template, record) {
  return renderTemplate(template, variablesForRecord(record));
}

module.exports = {
  DEFAULT_TEMPLATE,
  VARIABLES,
  TemplateError,
  validateTemplate,
  renderTemplate,
  renderForRecord,
  variablesForRecord,
  formatAmount,
  formatDate,
};
