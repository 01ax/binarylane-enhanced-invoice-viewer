#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('node:fs/promises');
const path = require('node:path');

const API_BASE = 'https://api.binarylane.com.au/v2/customers/my/invoices';
const VALID_MODES = new Set(['reconciled', 'per-server', 'both']);

function printHelp() {
  console.log(`Invoice GST debug tool

Usage:
  node tools/invoice-debug.js [options]

Data source:
  --invoice <number>          Invoice number (API or local data)
  --ref <customer reference>  Invoice reference (API or local data)
  --input <path|->            Local JSON file path (or - for stdin)

Analysis options:
  --server <name>             Optional server filter (canonical server name)
  --mode <reconciled|per-server|both>
                              Method to output (default: both)
  --json                      Print machine-readable JSON

Auth:
  BL_API_KEY                  Bearer token for BinaryLane API (required when --input is not used)

Examples:
  BL_API_KEY=... node tools/invoice-debug.js --invoice 02781372 --ref acc101036 --mode both
  node tools/invoice-debug.js --input ./sample-invoice.json --invoice 02781372
`);
}

function parseArgs(argv) {
  const opts = {
    mode: 'both',
    json: false,
    invoice: '',
    ref: '',
    server: '',
    input: ''
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];

    if (a === '--help' || a === '-h') {
      opts.help = true;
      continue;
    }
    if (a === '--json') {
      opts.json = true;
      continue;
    }
    if (a === '--invoice') {
      if (!next || next.startsWith('--')) throw new Error('Missing value for --invoice');
      opts.invoice = String(next).trim();
      i += 1;
      continue;
    }
    if (a === '--ref') {
      if (!next || next.startsWith('--')) throw new Error('Missing value for --ref');
      opts.ref = String(next).trim();
      i += 1;
      continue;
    }
    if (a === '--server') {
      if (!next || next.startsWith('--')) throw new Error('Missing value for --server');
      opts.server = String(next).trim();
      i += 1;
      continue;
    }
    if (a === '--mode') {
      if (!next || next.startsWith('--')) throw new Error('Missing value for --mode');
      opts.mode = String(next).trim().toLowerCase();
      i += 1;
      continue;
    }
    if (a === '--input') {
      if (!next || next.startsWith('--')) throw new Error('Missing value for --input');
      opts.input = String(next).trim();
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${a}`);
  }

  if (!VALID_MODES.has(opts.mode)) {
    throw new Error(`Invalid --mode "${opts.mode}". Expected reconciled, per-server, or both.`);
  }

  return opts;
}

const cents = (n) => Math.round(Number(n || 0) * 100);
const dec = (c) => Number((c / 100).toFixed(2));
const money = (c) => `$${dec(c).toFixed(2)}`;

function normalizeBatch(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.invoices)) return payload.invoices;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function fetchPage(apiKey, page) {
  const res = await fetch(`${API_BASE}?page=${page}&per_page=100`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    throw new Error(payload?.error || payload?.message || `API ${res.status}`);
  }
  return normalizeBatch(payload);
}

async function fetchAllInvoices(apiKey) {
  const out = [];
  for (let page = 1; page <= 200; page += 1) {
    const batch = await fetchPage(apiKey, page);
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

function isPrimaryServiceLine(name) {
  return /\s\/\sServer Operating System:/i.test(name || '');
}

function canonicalServiceName(name) {
  const n = String(name || '').trim();
  const cut = n.indexOf(' / Server Operating System:');
  let s = cut > 0 ? n.slice(0, cut).trim() : n;
  s = s.replace(/\s*\([^)]*hours\)\s*$/i, '').replace(/\s*\([^)]*to[^)]*\)\s*$/i, '').trim();
  return s || 'Service';
}

function groupInvoiceByServerOrder(items) {
  const groups = [];
  let current = null;

  for (let idx = 0; idx < (items || []).length; idx += 1) {
    const it = items[idx] || {};
    const name = (it.name || 'Unnamed item').trim();
    const amount = Number(it.amount || 0);

    if (isPrimaryServiceLine(name)) {
      current = { server: canonicalServiceName(name), rows: [] };
      groups.push(current);
      current.rows.push({ idx, name, amount, type: 'primary' });
      continue;
    }

    if (!current) {
      current = { server: 'Unassigned account items', rows: [] };
      groups.push(current);
    }
    current.rows.push({ idx, name, amount, type: 'addon' });
  }

  return groups;
}

function buildTaxModel(inv) {
  const items = (inv.invoice_items || []).map((it, idx) => ({
    idx,
    c: cents(it.amount),
    name: String(it.name || '').toLowerCase(),
    includesTax: Boolean(it.amount_includes_tax)
  }));

  const subtotal = items.reduce((a, i) => a + i.c, 0);
  const tax = cents(inv.tax || 0);
  const total = cents(inv.amount || 0);
  const hasNegative = items.some((i) => i.c < 0) || tax < 0;
  const hasCreditLike = items.some((i) => /credit|discount|refund|adjust/i.test(i.name));
  const hasIncludesTax = items.some((i) => i.includesTax);
  const expectedTax = Math.round(subtotal * 0.10);
  const ok = !hasNegative
    && !hasCreditLike
    && !hasIncludesTax
    && Math.abs((subtotal + tax) - total) <= 1
    && Math.abs(tax - expectedTax) <= 1;

  const gstByIdx = new Map();

  if (ok) {
    let sum = 0;
    for (const it of items) {
      const g = Math.round(it.c * 0.10);
      gstByIdx.set(it.idx, g);
      sum += g;
    }

    let remainder = tax - sum;
    if (remainder !== 0 && items.length) {
      const sorted = [...items].sort((a, b) => b.c - a.c);
      let k = 0;
      while (remainder !== 0 && k < sorted.length * 2) {
        const it = sorted[k % sorted.length];
        gstByIdx.set(it.idx, (gstByIdx.get(it.idx) || 0) + (remainder > 0 ? 1 : -1));
        remainder += remainder > 0 ? -1 : 1;
        k += 1;
      }
    }
  }

  return { ok, subtotal, tax, total, expectedTax, gstByIdx };
}

function analyzeInvoice(inv, serverFilter) {
  const taxModel = buildTaxModel(inv);
  const groups = groupInvoiceByServerOrder(inv.invoice_items || []);

  const perServer = new Map();
  const rowBreakdown = [];

  for (const g of groups) {
    if (serverFilter && g.server !== serverFilter) continue;

    const rec = perServer.get(g.server) || { server: g.server, ex: 0, reconciledGst: 0, rows: [] };

    for (const r of g.rows) {
      const ex = cents(r.amount);
      const lineRoundedGst = Math.round(ex * 0.10);
      const reconciledLineGst = taxModel.ok ? (taxModel.gstByIdx.get(r.idx) || 0) : lineRoundedGst;
      rec.ex += ex;
      rec.reconciledGst += reconciledLineGst;
      rec.rows.push({
        idx: r.idx,
        type: r.type,
        name: r.name,
        ex,
        lineRoundedGst,
        reconciledLineGst,
        lineDelta: reconciledLineGst - lineRoundedGst
      });
      rowBreakdown.push({ server: g.server, ...rec.rows[rec.rows.length - 1] });
    }

    perServer.set(g.server, rec);
  }

  const servers = [...perServer.values()].map((s) => {
    const perServerGst = Math.round(s.ex * 0.10);
    const reconciledInc = s.ex + s.reconciledGst;
    const perServerInc = s.ex + perServerGst;
    const deltaGst = s.reconciledGst - perServerGst;
    const roundingBehavior = deltaGst === 0
      ? 'No cent shift between methods'
      : (deltaGst > 0
        ? `Reconciled allocates +${deltaGst}c GST vs per-server rounding`
        : `Per-server rounding allocates +${Math.abs(deltaGst)}c GST vs reconciled`);

    return {
      server: s.server,
      ex: s.ex,
      reconciled: {
        gst: s.reconciledGst,
        inc: reconciledInc
      },
      perServer: {
        gst: perServerGst,
        inc: perServerInc
      },
      delta: {
        gst: deltaGst,
        inc: reconciledInc - perServerInc
      },
      roundingBehavior,
      rows: s.rows
    };
  });

  servers.sort((a, b) => a.server.localeCompare(b.server));

  const totals = servers.reduce((acc, s) => {
    acc.ex += s.ex;
    acc.reconciledGst += s.reconciled.gst;
    acc.reconciledInc += s.reconciled.inc;
    acc.perServerGst += s.perServer.gst;
    acc.perServerInc += s.perServer.inc;
    return acc;
  }, {
    ex: 0,
    reconciledGst: 0,
    reconciledInc: 0,
    perServerGst: 0,
    perServerInc: 0
  });

  const invoiceTax = cents(inv.tax || 0);
  const invoiceTotal = cents(inv.amount || 0);
  const invoiceEx = invoiceTotal - invoiceTax;

  const validation = {
    invoice: {
      ex: invoiceEx,
      gst: invoiceTax,
      inc: invoiceTotal
    },
    sumsFromIncludedServers: {
      ex: totals.ex,
      reconciledGst: totals.reconciledGst,
      reconciledInc: totals.reconciledInc,
      perServerGst: totals.perServerGst,
      perServerInc: totals.perServerInc
    },
    deltas: {
      reconciledVsInvoiceGst: totals.reconciledGst - invoiceTax,
      reconciledVsInvoiceInc: totals.reconciledInc - invoiceTotal,
      perServerVsInvoiceGst: totals.perServerGst - invoiceTax,
      perServerVsInvoiceInc: totals.perServerInc - invoiceTotal
    }
  };

  const notes = [];
  if (!taxModel.ok) {
    notes.push('Tax model fallback: invoice did not pass reconciliation safety checks, so reconciled line GST falls back to line rounding.');
  }
  if (validation.deltas.perServerVsInvoiceGst !== 0) {
    notes.push(`Per-server rounding GST differs from invoice GST by ${validation.deltas.perServerVsInvoiceGst} cent(s). This is expected when rounding at server granularity instead of line/reconciled allocation.`);
  }
  if (validation.deltas.reconciledVsInvoiceGst !== 0) {
    notes.push(`Reconciled GST differs from invoice GST by ${validation.deltas.reconciledVsInvoiceGst} cent(s). Check mapping/filtering or invoice tax-model guard conditions.`);
  }

  return {
    invoiceNumber: String(inv.invoice_number || ''),
    reference: String(inv.reference || ''),
    invoiceId: inv.invoice_id || null,
    taxModel,
    servers,
    totals,
    validation,
    notes,
    rowBreakdown
  };
}

function pad(s, width) {
  const v = String(s);
  return v.length >= width ? v : `${v}${' '.repeat(width - v.length)}`;
}

function printText(result, mode) {
  console.log(`Invoice #${result.invoiceNumber} (${result.reference || 'no ref'})`);
  console.log(`Tax model: ${result.taxModel.ok ? 'reconciled-safe' : 'fallback'} | invoice GST ${money(result.validation.invoice.gst)} | invoice total ${money(result.validation.invoice.inc)}`);
  console.log('');

  const headers = ['Server', 'Ex GST', 'Reconciled GST', 'Per-server GST', 'GST Δ', 'Reconciled Inc', 'Per-server Inc', 'Inc Δ', 'Rounding behavior'];
  const widths = [28, 11, 15, 14, 8, 16, 14, 8, 44];
  console.log(headers.map((h, i) => pad(h, widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));

  for (const s of result.servers) {
    const recG = mode === 'per-server' ? '-' : money(s.reconciled.gst);
    const psG = mode === 'reconciled' ? '-' : money(s.perServer.gst);
    const recI = mode === 'per-server' ? '-' : money(s.reconciled.inc);
    const psI = mode === 'reconciled' ? '-' : money(s.perServer.inc);
    const gDelta = mode === 'both' ? `${s.delta.gst >= 0 ? '+' : ''}${dec(s.delta.gst).toFixed(2)}` : '-';
    const iDelta = mode === 'both' ? `${s.delta.inc >= 0 ? '+' : ''}${dec(s.delta.inc).toFixed(2)}` : '-';

    const behavior = s.roundingBehavior.length > widths[8]
      ? `${s.roundingBehavior.slice(0, widths[8] - 1)}…`
      : s.roundingBehavior;

    console.log([
      pad(s.server, widths[0]),
      pad(money(s.ex), widths[1]),
      pad(recG, widths[2]),
      pad(psG, widths[3]),
      pad(gDelta, widths[4]),
      pad(recI, widths[5]),
      pad(psI, widths[6]),
      pad(iDelta, widths[7]),
      pad(behavior, widths[8])
    ].join('  '));
  }

  console.log('');
  console.log('Validation:');
  console.log(`  Included server sums ex GST: ${money(result.validation.sumsFromIncludedServers.ex)}`);
  console.log(`  Reconciled GST vs invoice GST delta: ${result.validation.deltas.reconciledVsInvoiceGst} cent(s)`);
  console.log(`  Per-server GST vs invoice GST delta: ${result.validation.deltas.perServerVsInvoiceGst} cent(s)`);
  console.log(`  Reconciled Inc vs invoice total delta: ${result.validation.deltas.reconciledVsInvoiceInc} cent(s)`);
  console.log(`  Per-server Inc vs invoice total delta: ${result.validation.deltas.perServerVsInvoiceInc} cent(s)`);

  if (result.notes.length) {
    console.log('');
    console.log('Notes:');
    for (const n of result.notes) console.log(`  - ${n}`);
  }
}

async function loadLocalJson(inputPath) {
  let raw;
  if (inputPath === '-') {
    raw = await new Promise((resolve, reject) => {
      const chunks = [];
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', reject);
    });
  } else {
    const abs = path.resolve(inputPath);
    raw = await fs.readFile(abs, 'utf8');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON from --input: ${err.message}`);
  }

  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.invoices)) return parsed.invoices;
  if (parsed && typeof parsed === 'object') return [parsed];
  throw new Error('Unsupported JSON shape for --input. Expected an invoice object, array, or { invoices: [...] }.');
}

function findInvoice(invoices, invoiceNumber, ref) {
  let out = invoices;
  if (invoiceNumber) out = out.filter((i) => String(i.invoice_number || '') === invoiceNumber);
  if (ref) out = out.filter((i) => String(i.reference || '') === ref);

  if (!out.length) {
    throw new Error(`No invoice matched filters (invoice="${invoiceNumber || '*'}", ref="${ref || '*'}").`);
  }
  if (out.length > 1) {
    throw new Error(`Filters matched ${out.length} invoices. Please narrow with --invoice and/or --ref.`);
  }
  return out[0];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }

  let invoices;
  if (opts.input) {
    invoices = await loadLocalJson(opts.input);
  } else {
    const apiKey = process.env.BL_API_KEY;
    if (!apiKey) {
      throw new Error('BL_API_KEY is required when --input is not supplied.');
    }
    invoices = await fetchAllInvoices(apiKey);
  }

  const invoice = findInvoice(invoices, opts.invoice, opts.ref);
  const result = analyzeInvoice(invoice, opts.server || '');

  if (!result.servers.length) {
    throw new Error(opts.server
      ? `No server rows matched --server "${opts.server}" on invoice ${result.invoiceNumber}.`
      : `No server rows found on invoice ${result.invoiceNumber}.`);
  }

  if (opts.json) {
    console.log(JSON.stringify({ mode: opts.mode, ...result }, null, 2));
    return;
  }

  printText(result, opts.mode);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  console.error('Use --help for usage examples.');
  process.exitCode = 1;
});
