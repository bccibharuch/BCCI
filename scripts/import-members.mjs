#!/usr/bin/env node
/**
 * Import existing members (from the Secretariat's spreadsheet) as Pending
 * applications, with their GST / PAN certificates attached.
 *
 *   node scripts/import-members.mjs --data <members.json> --docs <folder>            # dry run
 *   node --env-file=.env.local scripts/import-members.mjs --data ... --docs ... --apply
 *
 * Dry run touches nothing and needs no credentials. --apply writes through the
 * same storage layer the portal uses (Redis or Postgres per STORAGE_BACKEND),
 * so indexes and summaries stay consistent. Members whose email already has an
 * application are skipped, which makes re-running safe.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validateFileSignature } from '../api/_lib/validation.js';

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

// Keep in sync with MEMBERSHIP_FEES in api/applications.js.
const PLAN_BY_CATEGORY = {
  micro: { label: 'Micro & Small - ₹500 / Year', fee: 500 },
  small: { label: 'Micro & Small - ₹500 / Year', fee: 500 },
  medium: { label: 'Medium - ₹1,000 / Year', fee: 1000 },
  large: { label: 'Large - ₹2,500 / Year', fee: 2500 },
  general: { label: 'General Membership - ₹5,000/-', fee: 5000 },
  executive: { label: 'Executive Membership - ₹10,000/-', fee: 10000 },
  'executive vip': { label: 'Executive VIP Membership - ₹15,000/-', fee: 15000 },
};

const WARN_DOC_BYTES = 3 * 1024 * 1024;

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

/** Excel serial date (1900 system) → ISO timestamp at noon IST-safe UTC. */
function serialToIso(serial) {
  if (!Number.isFinite(serial)) fail(`Invalid sheet date: ${serial}`);
  return new Date(Math.round((serial - 25569) * 86400000) + 12 * 3600 * 1000).toISOString();
}

function placeholderEmail(company) {
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `no-email-${slug}@import.bcci.invalid`;
}

function loadDocument(docsDir, relPath) {
  const full = resolve(join(docsDir, relPath));
  if (!full.startsWith(resolve(docsDir))) throw new Error(`Document path escapes the docs folder: ${relPath}`);
  if (!existsSync(full)) throw new Error(`Document not found: ${relPath}`);
  const mime = MIME_BY_EXT[extname(full).toLowerCase()];
  if (!mime) throw new Error(`Unsupported document type: ${relPath}`);
  const dataUri = `data:${mime};base64,${readFileSync(full).toString('base64')}`;
  const check = validateFileSignature(dataUri);
  if (!check.ok) throw new Error(`${relPath}: ${check.error}`);
  return { dataUri, bytes: statSync(full).size };
}

/** Build one application record in the shape api/applications.js writes. */
function buildRecord(member, docsDir, index) {
  const category = String(member.msme || '').trim().toLowerCase();
  const plan = PLAN_BY_CATEGORY[category];
  if (!plan) throw new Error(`Unknown membership category "${member.msme}" for ${member.company}`);

  const notes = [...(member.notes || [])];
  const usedPlaceholder = !member.email;
  const email = (member.email || placeholderEmail(member.company)).trim().toLowerCase();
  const paid = member.feePaid;
  if (paid !== null && paid !== undefined && Number(paid) !== plan.fee) {
    notes.push(`Amount paid per sheet is ${paid}; portal fee for "${plan.label}" is ${plan.fee}.`);
  }

  const docs = { gstCertProof: '', panCertProof: '', regCertProof: '', repAttachment: '' };
  const docBytes = {};
  for (const [field, relPath] of Object.entries(member.docs || {})) {
    if (!(field in docs)) throw new Error(`Unknown document field "${field}" for ${member.company}`);
    const loaded = loadDocument(docsDir, relPath);
    docs[field] = loaded.dataUri;
    docBytes[field] = loaded.bytes;
  }

  const record = {
    id: `BCCI-${Date.now()}-${index}${randomBytes(3).toString('hex')}`,
    applicantName: member.repName,
    fullName: member.repName,
    subject: 'Membership (imported from Secretariat register)',
    repName: member.repName,
    repDesignation: 'Authorised Representative',
    repMobile: member.phone,
    repEmail: email,
    company: member.company,
    email,
    phone: member.phone,
    address: member.address || '',
    city: member.city,
    state: member.state || 'Gujarat',
    district: member.district || '',
    pincode: member.pincode || '',
    website: '',
    primaryBusiness: member.company,
    businessDescription: member.businessType || 'Not provided',
    internationalOps: '',
    regNumber: '',
    regDate: '',
    regPlace: '',
    otherAssociations: '',
    feedback: 'Imported from the Secretariat membership register.',
    membershipPlan: plan.label,
    paymentMode: '',
    gstin: member.gstNo || '',
    gstNo: member.gstNo || '',
    pan: member.panNo || '',
    panNo: member.panNo || '',
    legalStatus: member.legalStatus || '',
    enterpriseType: `${member.msme}`,
    businessServices: member.businessType || '',
    annualTurnover: '',
    employees: '',
    cin: '',
    membershipType: member.businessType || '',
    paymentProof: '',
    ...docs,
    paymentAmount: paid === null || paid === undefined ? '' : String(paid),
    totalFee: plan.fee,
    paymentRef: '',
    status: 'Pending',
    submittedAt: serialToIso(member.sheetDate),
    reviewedAt: null,
    reviewedBy: null,
    renewalYears: 1,
    importedAt: new Date().toISOString(),
    importNotes: notes,
    importedPayments: (member.extraPayments || []).map((p) => ({
      paidAt: serialToIso(p.sheetDate),
      amount: p.amount,
    })),
    importPlaceholderEmail: usedPlaceholder,
  };
  return { record, docBytes, notes };
}

function describe(member, record, docBytes) {
  const docList = Object.keys(docBytes).map((f) => f.replace('CertProof', '')).join('+') || 'none';
  const kb = Object.values(docBytes).reduce((a, b) => a + b, 0) / 1024;
  return `${member.company.padEnd(40)} ${record.email.padEnd(44)} ${record.membershipPlan.padEnd(40)} paid=${String(record.paymentAmount || '-').padEnd(6)} docs=${docList} (${kb.toFixed(0)} KB)`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      data: { type: 'string' },
      docs: { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  if (!values.data || !values.docs) fail('Usage: import-members.mjs --data <members.json> --docs <folder> [--apply]');

  const members = JSON.parse(readFileSync(values.data, 'utf8'));
  if (!Array.isArray(members) || !members.length) fail('Data file must be a non-empty JSON array.');

  const built = members.map((m, i) => {
    try {
      return { member: m, ...buildRecord(m, values.docs, i) };
    } catch (err) {
      return fail(err.message);
    }
  });

  const emails = built.map((b) => b.record.email);
  const dup = emails.find((e, i) => emails.indexOf(e) !== i);
  if (dup) fail(`Duplicate email in data file: ${dup}`);

  console.log(values.apply ? 'APPLY mode: writing records.\n' : 'DRY RUN: nothing will be written.\n');
  for (const b of built) {
    console.log(describe(b.member, b.record, b.docBytes));
    for (const note of b.notes) console.log(`    - ${note}`);
    const big = Object.entries(b.docBytes).filter(([, n]) => n > WARN_DOC_BYTES);
    for (const [field] of big) console.log(`    ! ${field} is over 3 MB; the portal rejects uploads that large.`);
  }

  if (!values.apply) {
    console.log(`\n${built.length} records ready. Re-run with --apply (and credentials) to import.`);
    return;
  }

  const { initStorage, getApplicationByEmail, putApplication, STORAGE_BACKEND } = await import('../api/_lib/records.js');
  console.log(`\nStorage backend: ${STORAGE_BACKEND}`);
  await initStorage();

  const counts = { imported: 0, skipped: 0, failed: 0 };
  for (const b of built) {
    try {
      const existing = await getApplicationByEmail(b.record.email);
      if (existing) {
        counts.skipped++;
        console.log(`SKIP    ${b.member.company}: email already has application ${existing.id}`);
        continue;
      }
      const saved = await putApplication(b.record);
      counts.imported++;
      console.log(`IMPORT  ${b.member.company}: ${saved.id}`);
    } catch (err) {
      counts.failed++;
      console.error(`FAIL    ${b.member.company}: ${err.message}`);
    }
  }
  console.log(`\nDone. imported=${counts.imported} skipped=${counts.skipped} failed=${counts.failed}`);
  if (counts.failed) process.exit(1);
}

await main();
