#!/usr/bin/env node
/**
 * Operator billing console (ENH-003).
 *
 * There is no payment gateway and, with a handful of customers, there does not
 * need to be one: the money arrives by UPI or bank transfer and this marks the
 * period paid. It is deliberately a script rather than a web screen, because a
 * screen would need a cross-organisation login — the single highest-value
 * credential in the system — to list customers you can already list with the
 * database credentials you hold anyway.
 *
 * NOTE: this is an operator tool for BhoomiTrack the business. It is not the
 * `super_admin` role, which belongs to each CUSTOMER's own organisation.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." node admin-billing.js <command> [args]
 *
 *   list [--status=active] [--plan=contractor]     every organisation and what it owes
 *   show <org>                                     one organisation, with payment history
 *   set-plan  <org> --plan=contractor --cycle=annual
 *   set-price <org> --per-site=999 | --flat=40000 | --clear   [--note="..."]
 *       --per-site is ALWAYS per site per MONTH; an annual cycle multiplies by 12.
 *       --flat is the whole amount for one cycle.
 *   mark-paid <org> --amount=20000 [--months=12 | --lifetime] [--method=upi] [--ref=UTR123]
 *   extend-trial <org> --days=30
 *   suspend   <org> --reason="Payment overdue"
 *   unsuspend <org>
 *   web-access <email> --on | --off              grant or revoke console access
 *
 * <org> is an id or any part of the organisation's name.
 * Amounts are typed in RUPEES; they are stored as integer paise.
 *
 * Every mutating command previews the change and does nothing. Add --yes to apply.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Organization = require('./models/Organization');
const User = require('./models/User');
const Site = require('./models/Site');
const AuditLog = require('./models/AuditLog');
const {
  PRICING, PLAN_LABELS, priceFor, bestPlanFor, quoteForOrg, formatINR, rupeesToPaise,
} = require('./utils/pricing');

if (require.main === module && !process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI is required. Refusing to guess a connection string.');
  process.exit(1);
}

// ─── argument parsing ────────────────────────────────────────────────────────
// Parsed inside main() rather than at load, so requiring this file for a test
// neither reads argv nor opens a database connection.
let command; let positional; let flags; let APPLY; let OPERATOR;

function parseArgs(argv) {
  command = argv[0];
  positional = argv.slice(1).filter((a) => !a.startsWith('--'));
  flags = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, ...rest] = arg.slice(2).split('=');
    flags[key] = rest.length ? rest.join('=') : true;
  }
  APPLY = flags.yes === true;
  OPERATOR = flags.by || process.env.USER || 'operator';
}

const log = (...a) => console.log(...a);
const days = (n) => n * 24 * 60 * 60 * 1000;

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
  return null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function resolveOrg(needle) {
  if (!needle) return fail('Which organisation? Pass an id or part of the name.');

  if (mongoose.Types.ObjectId.isValid(needle)) {
    const byId = await Organization.findById(needle);
    if (byId) return byId;
  }
  const matches = await Organization.find({ name: new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });
  if (matches.length === 0) return fail(`No organisation matches "${needle}".`);
  if (matches.length > 1) {
    console.error(`❌ "${needle}" matches ${matches.length} organisations:`);
    for (const m of matches) console.error(`   ${m._id}  ${m.name}`);
    process.exitCode = 1;
    return null;
  }
  return matches[0];
}

async function countsFor(orgId) {
  const [sites, users] = await Promise.all([
    Site.countDocuments({ orgId }),
    User.countDocuments({ orgId, status: 'approved' }),
  ]);
  return { sites, users };
}

function daysLeft(org) {
  const end = org.status === 'trialing' ? org.trialEndsAt : org.currentPeriodEnd;
  if (!end) return org.status === 'active' ? Infinity : null;
  return Math.ceil((end.getTime() - Date.now()) / days(1));
}

function renderDaysLeft(org) {
  const d = daysLeft(org);
  if (d === null) return '—';
  if (d !== Infinity) return d < 0 ? `${-d}d ago` : `${d}d`;
  // An active org with no period end never expires. That is correct for Founding
  // and almost certainly an operator slip for anything else, so the two must not
  // read the same — a customer billed nothing forever is invisible otherwise.
  return org.plan === 'founding' ? 'lifetime' : 'no end ⚠';
}

function table(rows, headers) {
  if (rows.length === 0) return log('  (none)');
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  log(line(headers));
  log('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) log(line(r));
}

// Audit rows are written directly rather than through utils/audit, which needs a
// request for actor identity. An operator has no req.user; actor_id stays null
// and the name records who ran the script.
async function auditOperator(org, action, before, after, note) {
  try {
    await AuditLog.create({
      orgId: org._id,
      actor_name: OPERATOR,
      actor_role: 'operator',
      action, entity: 'organization',
      entity_id: org._id, entity_label: org.name,
      before, after, note: note || '',
    });
  } catch (err) {
    console.error('[AUDIT] not recorded:', err.message);
  }
}

function preview(label, before, after) {
  log('');
  log(`  ${label}`);
  for (const key of Object.keys(after)) {
    const b = before[key] === undefined || before[key] === null ? '—' : String(before[key]);
    const a = after[key] === null ? '—' : String(after[key]);
    if (b !== a) log(`    ${key.padEnd(20)} ${b}  →  ${a}`);
  }
  log('');
  if (!APPLY) log('  Nothing changed. Re-run with --yes to apply.');
}

// ─── commands ────────────────────────────────────────────────────────────────

async function cmdList() {
  const query = {};
  if (typeof flags.status === 'string') query.status = flags.status;
  if (typeof flags.plan === 'string') query.plan = flags.plan;

  const orgs = await Organization.find(query).sort({ createdAt: 1 });
  const rows = [];
  let owedPaise = 0;
  let collectedPaise = 0;

  for (const org of orgs) {
    const { sites, users } = await countsFor(org._id);
    const quote = quoteForOrg(org, sites);
    const paid = org.totalPaidPaise();
    const last = (org.payments || []).slice(-1)[0];

    if (org.isActive() && quote.totalPaise) owedPaise += quote.totalPaise;
    collectedPaise += paid;

    rows.push([
      String(org._id),
      org.name.length > 26 ? org.name.slice(0, 25) + '…' : org.name,
      org.status,
      PLAN_LABELS[org.plan] || org.plan,
      org.billing?.cycle || '—',
      sites,
      users,
      formatINR(quote.totalPaise),
      quote.basis.startsWith('negotiated') ? '*' : '',
      renderDaysLeft(org),
      last ? last.paidAt.toISOString().slice(0, 10) : 'never',
      formatINR(paid),
    ]);
  }

  log('');
  log(`  ${orgs.length} organisation${orgs.length === 1 ? '' : 's'}`);
  log('');
  table(rows, ['ID', 'NAME', 'STATUS', 'PLAN', 'CYCLE', 'SITES', 'USERS', 'OWES', '', 'LEFT', 'LAST PAID', 'COLLECTED']);
  log('');
  log(`  * = negotiated price, not list`);
  log(`  Recurring across active organisations: ${formatINR(owedPaise)} per cycle`);
  log(`  Collected to date:                     ${formatINR(collectedPaise)}`);
  log('');
}

async function cmdShow() {
  const org = await resolveOrg(positional[0]);
  if (!org) return;
  const { sites, users } = await countsFor(org._id);
  const quote = quoteForOrg(org, sites);
  const best = bestPlanFor(org.billing?.cycle || 'monthly', sites);

  log('');
  log(`  ${org.name}`);
  log(`  ${org._id}`);
  log('');
  log(`  status         ${org.status}${org.isActive() ? '' : `  (${org.inactiveReason()})`}`);
  log(`  plan           ${PLAN_LABELS[org.plan] || org.plan}  ·  ${org.billing?.cycle || 'monthly'}`);
  log(`  sites / users  ${sites} / ${users}`);
  log(`  trial ends     ${org.trialEndsAt ? org.trialEndsAt.toISOString().slice(0, 10) : '—'}`);
  log(`  period ends    ${org.currentPeriodEnd ? org.currentPeriodEnd.toISOString().slice(0, 10) : (org.status === 'active' ? 'never (lifetime)' : '—')}`);
  log(`  GSTIN          ${org.billing?.gstin || '—'}`);
  log('');
  log(`  owes           ${formatINR(quote.totalPaise)}  per ${org.billing?.cycle || 'month'}   [${quote.basis}]`);
  if (quote.basis !== 'list' && quote.listPaise !== null && quote.listPaise !== undefined) {
    log(`  list price     ${formatINR(quote.listPaise)}`);
    if (org.billing?.note) log(`  agreed         ${org.billing.note}`);
    if (org.billing?.agreedAt) log(`  agreed on      ${org.billing.agreedAt.toISOString().slice(0, 10)} by ${org.billing.agreedBy || '—'}`);
  }
  if (best && best.plan !== org.plan && quote.basis === 'list' && best.totalPaise < (quote.totalPaise ?? Infinity)) {
    log(`  ⚠  cheaper on  ${PLAN_LABELS[best.plan]} — ${formatINR(best.totalPaise)}`);
  }
  log('');
  log('  Payments');
  table(
    (org.payments || []).map((p) => [
      p.paidAt.toISOString().slice(0, 10),
      formatINR(p.amountPaise),
      p.method || '—',
      p.reference || '—',
      p.periodEnd ? p.periodEnd.toISOString().slice(0, 10) : 'lifetime',
      p.siteCount ?? '—',
      p.recordedBy || '—',
    ]),
    ['PAID ON', 'AMOUNT', 'METHOD', 'REFERENCE', 'COVERS TO', 'SITES', 'BY']
  );
  log('');
  log(`  Total collected: ${formatINR(org.totalPaidPaise())}`);
  log('');
}

async function cmdSetPlan() {
  const org = await resolveOrg(positional[0]);
  if (!org) return;

  const plan = flags.plan || org.plan;
  const cycle = flags.cycle || org.billing?.cycle || 'monthly';
  if (!Organization.ORG_PLANS.includes(plan)) {
    return fail(`Unknown plan "${plan}". One of: ${Organization.ORG_PLANS.join(', ')}`);
  }
  if (plan !== 'trial' && !(PRICING[cycle] && PRICING[cycle][plan])) {
    return fail(`There is no ${plan} price on a ${cycle} cycle. Available: ${
      Object.entries(PRICING).map(([c, p]) => `${c}=${Object.keys(p).join('/')}`).join('  ')}`);
  }

  const before = { plan: org.plan, cycle: org.billing?.cycle };
  preview(`${org.name}`, before, { plan, cycle });
  if (!APPLY) return;

  org.plan = plan;
  org.billing.cycle = cycle;
  await org.save();
  await auditOperator(org, 'org.set_plan', before, { plan, cycle });
  log(`  ✅ ${org.name} is on ${PLAN_LABELS[plan]} (${cycle}).`);
}

async function cmdSetPrice() {
  const org = await resolveOrg(positional[0]);
  if (!org) return;

  const before = {
    pricePerSitePaise: org.billing?.pricePerSitePaise,
    flatAmountPaise: org.billing?.flatAmountPaise,
  };
  let after;

  if (flags.clear) {
    after = { pricePerSitePaise: null, flatAmountPaise: null };
  } else if (flags['per-site'] !== undefined) {
    after = { pricePerSitePaise: rupeesToPaise(flags['per-site']), flatAmountPaise: null };
  } else if (flags.flat !== undefined) {
    after = { pricePerSitePaise: null, flatAmountPaise: rupeesToPaise(flags.flat) };
  } else {
    return fail('Pass one of --per-site=999, --flat=40000, or --clear.');
  }

  if ((after.pricePerSitePaise ?? 0) < 0 || (after.flatAmountPaise ?? 0) < 0) {
    return fail('A negotiated price cannot be negative.');
  }

  const { sites } = await countsFor(org._id);
  preview(`${org.name} — ${sites} site${sites === 1 ? '' : 's'}`, before, after);
  if (!APPLY) {
    const hypothetical = { ...org.toObject(), billing: { ...org.billing.toObject(), ...after } };
    log(`  Would owe ${formatINR(quoteForOrg(hypothetical, sites).totalPaise)} per ${org.billing?.cycle || 'month'}` +
        ` (list: ${formatINR((priceFor(org.plan, org.billing?.cycle || 'monthly', sites) || {}).totalPaise)})`);
    log('');
    return;
  }

  Object.assign(org.billing, after, {
    agreedAt: new Date(),
    agreedBy: OPERATOR,
    note: typeof flags.note === 'string' ? flags.note : org.billing.note,
  });
  await org.save();
  await auditOperator(org, 'org.set_price', before, after, org.billing.note);
  log(`  ✅ ${org.name} now owes ${formatINR(quoteForOrg(org, sites).totalPaise)} per ${org.billing.cycle}.`);
}

async function cmdMarkPaid() {
  const org = await resolveOrg(positional[0]);
  if (!org) return;
  if (flags.amount === undefined) return fail('How much was paid? Pass --amount=20000 (rupees).');

  const amountPaise = rupeesToPaise(flags.amount);
  if (!Number.isFinite(amountPaise) || amountPaise < 0) return fail('--amount must be a non-negative number of rupees.');

  const { sites } = await countsFor(org._id);
  const lifetime = flags.lifetime === true;
  const months = lifetime ? null : Number(flags.months || (org.billing?.cycle === 'annual' ? 12 : 1));
  if (!lifetime && (!Number.isFinite(months) || months <= 0)) return fail('--months must be a positive number.');

  // Extend from whichever is later: now, or the end of a period still running —
  // so paying early adds time rather than throwing it away.
  const from = org.currentPeriodEnd && org.currentPeriodEnd > new Date() ? org.currentPeriodEnd : new Date();
  const periodEnd = lifetime ? null : new Date(from.getTime() + days(30.4375 * months));

  // Founding is the only lifetime tier there is, so a lifetime payment moves the
  // org onto it — otherwise the plan says "Contractor, monthly" while the period
  // never ends, and the list is quietly wrong about what was sold.
  const founding = PRICING.lifetime.founding;
  if (lifetime && sites > founding.includedSites) {
    log(`  ⚠  Founding covers ${founding.includedSites} sites; this organisation has ${sites}.`);
    log('     Take the payment if you have agreed to, but the cap is now untrue for them.');
    log('');
  }

  const expected = quoteForOrg(org, sites).totalPaise;
  const before = {
    status: org.status,
    plan: org.plan,
    cycle: org.billing?.cycle,
    currentPeriodEnd: org.currentPeriodEnd?.toISOString().slice(0, 10),
  };
  const after = {
    status: 'active',
    plan: lifetime ? 'founding' : org.plan,
    cycle: lifetime ? 'lifetime' : org.billing?.cycle,
    currentPeriodEnd: periodEnd ? periodEnd.toISOString().slice(0, 10) : 'never (lifetime)',
  };

  preview(`${org.name} — ${formatINR(amountPaise)} received`, before, after);
  if (expected !== null && expected !== undefined && amountPaise !== expected) {
    log(`  ⚠  expected ${formatINR(expected)} for ${sites} site${sites === 1 ? '' : 's'}; recording ${formatINR(amountPaise)} as given.`);
    log('');
  }
  if (!APPLY) return;

  org.status = 'active';
  org.currentPeriodEnd = periodEnd;
  if (lifetime) { org.plan = 'founding'; org.billing.cycle = 'lifetime'; }
  org.suspendedAt = null;
  org.suspensionReason = '';
  org.payments.push({
    amountPaise,
    paidAt: flags.on ? new Date(flags.on) : new Date(),
    method: typeof flags.method === 'string' ? flags.method : '',
    reference: typeof flags.ref === 'string' ? flags.ref : '',
    periodStart: from,
    periodEnd,
    plan: org.plan,
    siteCount: sites,
    recordedBy: OPERATOR,
    note: typeof flags.note === 'string' ? flags.note : '',
  });
  await org.save();
  await auditOperator(org, 'org.payment_recorded', before, { ...after, amountPaise });
  log(`  ✅ ${org.name} is active ${periodEnd ? `until ${periodEnd.toDateString()}` : 'for life'}. Collected to date: ${formatINR(org.totalPaidPaise())}.`);
}

async function cmdExtendTrial() {
  const org = await resolveOrg(positional[0]);
  if (!org) return;
  const n = Number(flags.days);
  if (!Number.isFinite(n) || n === 0) return fail('Pass --days=30.');

  const from = org.trialEndsAt && org.trialEndsAt > new Date() ? org.trialEndsAt : new Date();
  const trialEndsAt = new Date(from.getTime() + days(n));
  const before = { status: org.status, trialEndsAt: org.trialEndsAt?.toISOString().slice(0, 10) };
  const after = { status: 'trialing', trialEndsAt: trialEndsAt.toISOString().slice(0, 10) };

  preview(`${org.name}`, before, after);
  if (!APPLY) return;

  org.status = 'trialing';
  org.trialEndsAt = trialEndsAt;
  await org.save();
  await auditOperator(org, 'org.extend_trial', before, after);
  log(`  ✅ ${org.name} trials until ${trialEndsAt.toDateString()}.`);
}

// Grant or revoke the web console entitlement by email. The same thing the super
// admin will do from the Owners screen — available now, because that screen does
// not exist yet.
//
// This is PERMISSION only. Whether the company has paid is a separate fact on the
// Organization and is not touched here.
async function cmdWebAccess() {
  const email = (positional[0] || '').toLowerCase().trim();
  if (!email) return fail('Which account? Pass an email address.');
  if (flags.on === undefined && flags.off === undefined) return fail('Pass --on or --off.');
  const enabled = flags.on !== undefined;

  const user = await User.findOne({ email, deletedAt: null });
  if (!user) {
    // Say so plainly. This is an operator tool, not a login form — there is no
    // account enumeration to defend against here, and a silent no-op is worse.
    const near = await User.find({ email: new RegExp(email.split('@')[0], 'i'), deletedAt: null })
      .select('email role').limit(5).lean();
    fail(`No live account for "${email}".`);
    if (near.length) {
      console.error('   Did you mean:');
      for (const n of near) console.error(`     ${n.email}  (${n.role})`);
    }
    return null;
  }

  if (user.role === 'super_admin') {
    return fail(`${user.name} is the Super Admin and always has web access. Nothing to change.`);
  }
  if (user.role !== 'owner') {
    return fail(`${user.name} is a ${user.role}. Only an owner can be given web access — a manager works at a site, on a phone.`);
  }

  const org = await Organization.findById(user.orgId);
  const before = { webAppAccess: Boolean(user.webAppAccess) };
  log('');
  log(`  ${user.name} <${user.email}>`);
  log(`  ${org ? org.name : 'no organisation'} — ${org ? org.status : '?'}`);
  if (org && !org.isActive()) {
    log(`  ⚠  This organisation is not active: ${org.inactiveReason()}`);
    log('     Access can be granted anyway; the API will still answer 402 until it is paid.');
  }
  preview('', before, { webAppAccess: enabled });
  if (!APPLY) return;

  user.webAppAccess = enabled;
  await user.save();
  if (org) await auditOperator(org, enabled ? 'user.grant_web_access' : 'user.revoke_web_access',
    before, { webAppAccess: enabled }, `${user.email} by operator`);
  log(`  ✅ ${user.name} ${enabled ? 'can now' : 'can no longer'} sign in to the web console.`);
  log('');
}

async function cmdSuspend() {
  const org = await resolveOrg(positional[0]);
  if (!org) return;
  const reason = typeof flags.reason === 'string' ? flags.reason : '';
  if (!reason) return fail('Pass --reason="..." — it is shown to the customer verbatim.');

  const before = { status: org.status };
  preview(`${org.name} — customer will see: "${reason}"`, before, { status: 'suspended' });
  if (!APPLY) return;

  org.status = 'suspended';
  org.suspendedAt = new Date();
  org.suspensionReason = reason;
  await org.save();
  await auditOperator(org, 'org.suspend', before, { status: 'suspended' }, reason);
  log(`  ✅ ${org.name} suspended. Their data and login are untouched; the API answers 402.`);
}

async function cmdUnsuspend() {
  const org = await resolveOrg(positional[0]);
  if (!org) return;

  // Back to whichever period they still hold, rather than assuming they paid.
  const stillInTrial = org.trialEndsAt && org.trialEndsAt > new Date();
  const status = stillInTrial ? 'trialing' : 'active';
  const before = { status: org.status, suspensionReason: org.suspensionReason };
  preview(`${org.name}`, before, { status, suspensionReason: '' });
  if (!APPLY) return;

  org.status = status;
  org.suspendedAt = null;
  org.suspensionReason = '';
  await org.save();
  await auditOperator(org, 'org.unsuspend', before, { status });
  log(`  ✅ ${org.name} is ${status}.`);
}

const COMMANDS = {
  list: cmdList,
  show: cmdShow,
  'set-plan': cmdSetPlan,
  'set-price': cmdSetPrice,
  'mark-paid': cmdMarkPaid,
  'extend-trial': cmdExtendTrial,
  'web-access': cmdWebAccess,
  suspend: cmdSuspend,
  unsuspend: cmdUnsuspend,
};

async function main(argv = process.argv.slice(2)) {
  parseArgs(argv);

  if (!command || !COMMANDS[command]) {
    log('');
    log('  BhoomiTrack operator billing console');
    log('');
    log('    list [--status=] [--plan=]              every organisation and what it owes');
    log('    show <org>                             one organisation, with payment history');
    log('    set-plan     <org> --plan= --cycle=');
    log('    set-price    <org> --per-site=999 | --flat=40000 | --clear  [--note=]');
    log('                       --per-site is per site per MONTH; annual multiplies by 12');
    log('    mark-paid    <org> --amount=20000 [--months=12 | --lifetime] [--method=] [--ref=]');
    log('    extend-trial <org> --days=30');
    log('    suspend      <org> --reason="..."');
    log('    unsuspend    <org>');
    log('    web-access   <email> --on | --off              grant/revoke console access');
    log('');
    log('  <org> is an id or part of a name. Amounts in rupees. Add --yes to apply.');
    log('');
    log('  List prices:');
    for (const [cycle, plans] of Object.entries(PRICING)) {
      for (const [plan, t] of Object.entries(plans)) {
        log(`    ${(PLAN_LABELS[plan] || plan).padEnd(12)} ${cycle.padEnd(9)} ${formatINR(t.basePaise).padStart(10)} ` +
            `for ${String(t.includedSites).padStart(2)} site${t.includedSites === 1 ? ' ' : 's'}` +
            `${t.overagePerSitePaise === null ? '  (capped)' : `, then ${formatINR(t.overagePerSitePaise)}/site`}`);
      }
    }
    log('');
    process.exitCode = command ? 1 : 0;
    return;
  }

  const alreadyConnected = mongoose.connection.readyState === 1;
  if (!alreadyConnected) await mongoose.connect(process.env.MONGODB_URI);
  try {
    await COMMANDS[command]();
  } finally {
    if (!alreadyConnected) await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
  });
}

module.exports = { main };
