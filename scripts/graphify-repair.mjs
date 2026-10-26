#!/usr/bin/env node
/**
 * Repairs the graphify-out/graph.json artifact after a graphify build.
 *
 * graphify's AST extractor has two gaps this script closes:
 *
 *   1. Import specifiers with cache-busting query suffixes (`./store.js?v=4.0.4`)
 *      are not resolved to the real file node. The import edge points at a
 *      self-referential `ref_*` placeholder node, and dynamic imports create
 *      whole phantom file nodes (`js/board-admin.js?v=1.0.0`) instead of
 *      reusing the real ones.
 *   2. Cross-file instance-method calls (`this.store.getEvents()`) are never
 *      extracted, so callers like app.js show no usage edges into Store.
 *
 * Run after every `graphify update .`:
 *   node scripts/graphify-repair.mjs && graphify export html
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GRAPH_PATH = path.join(ROOT, 'graphify-out', 'graph.json');

const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
const nodes = graph.nodes;
const links = graph.links;
const byId = new Map(nodes.map((n) => [n.id, n]));

let repointedImports = 0;
let addedEdges = 0;
let updatedEdges = 0;
const skipped = [];
const dedup = new Set(links.map((l) => `${l.source}|${l.target}|${l.relation}`));

/* ── 1. Resolve versioned ref_* import placeholders to real file nodes ──
 * Only fires when the candidate node actually exists, so legitimate external
 * module refs (ref_crypto, ref_pg, ref_nodemailer, …) are never touched.   */

for (const link of links) {
  if (!link.target.startsWith('ref_')) continue;
  const candidate =
    'js_' + link.target.replace(/^ref_/, '').replace(/_js_v_[\d._]+$/, '');
  if (byId.has(candidate) && candidate !== link.target) {
    link.target = candidate;
    repointedImports += 1;
  }
}

/* ── 2. Point import-ish edges at the FILE node, not a class inside it ──
 * Phantom `?v=` file nodes and (from earlier runs) class nodes both get
 * normalized: js_board_admin_boardadmin -> js_board_admin, and so on.     */

for (const link of links) {
  if (!['imports_from', 'dynamic_import', 'imports'].includes(link.relation)) continue;
  const target = byId.get(link.target);
  const sf = (target?.source_file || '');
  if (!sf.startsWith('js/')) continue;
  const base = sf.split('?')[0];
  const fileId = 'js_' + path.basename(base, '.js').replace(/[^a-zA-Z0-9_]/g, '_');
  if (fileId !== link.target && byId.has(fileId)) {
    link.target = fileId;
    repointedImports += 1;
  }
}

/* ── 3. Add cross-file `this.store.<method>()` call edges ─────────── */

const CLASS_ID = {
  'js/app.js': 'js_app_app',
  'js/board-admin.js': 'js_board_admin_boardadmin',
  'js/board-portal.js': 'js_board_portal_boardportal',
  'js/checkin.js': 'js_checkin_checkindesk',
};

// One edge per caller→callee pair; weight = number of call sites in the source.
const callCounts = new Map();
const callContext = new Map();

for (const file of Object.keys(CLASS_ID)) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  let klass = null;
  let method = null;
  const classRe = /^class\s+([A-Za-z_$][\w$]*)/;
  const methodRe = /^\s{2}(?:static\s+)?(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*\(/;

  for (let i = 0; i < src.length; i++) {
    const line = src[i];
    const cm = line.match(classRe);
    if (cm) {
      klass = cm[1];
      method = null;
      continue;
    }
    const mm = line.match(methodRe);
    if (mm) method = mm[1];

    const callerClass = klass === 'Projector' ? 'js_board_admin_projector' : CLASS_ID[file];
    // The AST extractor strips leading underscores from method ids:
    // ._bindProfileDropdownActions() -> js_app_app_bindprofiledropdownactions
    const caller = `${callerClass}_${(method || '').replace(/^_+/, '').toLowerCase()}`;

    // `new Store()` in the constructor instantiates the class node.
    if (file === 'js/app.js' && /new\s+Store\s*\(/.test(line) && method === 'constructor') {
      countCall('js_app_app_constructor', 'js_store_store', i + 1, file, 'instantiation');
    }

    const callRe = /this\.store\.([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = callRe.exec(line)) !== null) {
      const target = `js_store_store_${m[1].toLowerCase()}`;
      countCall(caller, target, i + 1, file, 'call');
    }
  }
}

function countCall(source, target, line, file, context) {
  if (!methodOk(source) || !methodOk(target)) return;
  if (source === target) return;
  if (!byId.has(source)) return skipped.push(`caller ${source} (${file}:${line})`);
  if (!byId.has(target)) return skipped.push(`target ${target} (${file}:${line})`);
  const key = `${source}|${target}|calls`;
  callCounts.set(key, (callCounts.get(key) || 0) + 1);
  callContext.set(key, context);
}

// Existing links keyed for idempotent weight correction on re-runs.
const existingByKey = new Map(links.map((l) => [`${l.source}|${l.target}|${l.relation}`, l]));

for (const [key, count] of callCounts) {
  const [source, target] = key.split('|');
  const existing = existingByKey.get(key);
  if (existing) {
    // This script added it on a previous run — refresh weight from source.
    if (existing._origin === 'ast' && existing.context === callContext.get(key)) {
      existing.weight = count;
      updatedEdges += 1;
    }
    continue;
  }
  dedup.add(key);
  existingByKey.set(key, null);
  links.push({
    source,
    target,
    relation: 'calls',
    _origin: 'ast',
    confidence: 'EXTRACTED',
    confidence_score: 1.0,
    context: callContext.get(key),
    source_file: byId.get(source)?.source_file,
    source_location: byId.get(source)?.source_location,
    weight: count,
  });
  addedEdges += 1;
}

function methodOk(id) {
  return /^js_[a-z0-9_]+_[a-z0-9_]+$/i.test(id);
}

/* ── 4. Drop the now-orphaned phantom/ref nodes ───────────────────── */

const drop = new Set();
for (const n of nodes) {
  const sf = n.source_file || '';
  // Phantom file nodes for versioned specifiers.
  if (sf.includes('?v=')) drop.add(n.id);
  // Self-referential ref placeholders (label === id) that lost all edges.
  if (n.id.startsWith('ref_') && n.label === n.id) drop.add(n.id);
}
if (drop.size) {
  const live = new Set(links.flatMap((l) => [l.source, l.target]));
  for (const he of graph.hyperedges || []) {
    for (const id of he.nodes || []) live.add(id);
  }
  for (const id of drop) if (live.has(id)) drop.delete(id);
  graph.nodes = nodes.filter((n) => !drop.has(n.id));
}

/* ── Write back atomically ────────────────────────────────────────── */

const tmp = GRAPH_PATH + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(graph));
fs.renameSync(tmp, GRAPH_PATH);

console.log(`repaired ${GRAPH_PATH}`);
console.log(`  repointed import edges:      ${repointedImports}`);
console.log(`  dropped orphaned nodes:      ${drop.size}`);
console.log(`  added cross-file call edges: ${addedEdges}`);
console.log(`  refreshed call-site weights: ${updatedEdges}`);
console.log(`  links now: ${graph.links.length}`);
if (skipped.length) {
  console.warn(`  skipped ${skipped.length} call sites:`);
  for (const s of skipped.slice(0, 20)) console.warn('    ' + s);
}
