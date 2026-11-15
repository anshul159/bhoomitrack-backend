// Recurring statutory due dates (BhoomiTrack Services, plan §6.3 "Calendar").
//
// LIKE config/companyFileRules.js, THESE ARE PROMPTS FOR THE OWNER TO CHECK WITH
// THEIR CA, NOT ADVICE. Each date carries its basis; the partner CA signs this
// file off before release. Dates that fall on a holiday are often extended by
// notification; the app says "due on", never "late after".
//
// An entry:
//   id          stable, used in signal ids
//   applies(c)  pure: c = { profile, inPlace: Set of company-file slots that are in place }
//   dates(y)    the due dates in calendar year `y`, as [month (1-12), day] pairs
//   service_id  the catalogue entry that would take care of it, or null

const monthly = (day) => () => Array.from({ length: 12 }, (_, i) => [i + 1, day]);

const CALENDAR = [
  {
    id: 'gstr1',
    title: 'GSTR-1 (sales)',
    line: 'Monthly GST return of your invoices',
    applies: (c) => Boolean(c.profile.gstin),
    dates: monthly(11),
    service_id: 'tax.gst_filing',
    basis: 'CGST Rules: the 11th of the next month for monthly filers (quarterly filers differ)',
  },
  {
    id: 'gstr3b',
    title: 'GSTR-3B (tax payment)',
    line: 'Monthly GST return and payment',
    applies: (c) => Boolean(c.profile.gstin),
    dates: monthly(20),
    service_id: 'tax.gst_filing',
    basis: 'CGST Rules: the 20th of the next month for monthly filers (quarterly filers differ)',
  },
  {
    id: 'tds_payment',
    title: 'TDS deposit',
    line: 'TDS deducted last month is paid to the government',
    applies: (c) => c.inPlace.has('tax.tan'),
    dates: monthly(7),
    service_id: 'tax.tds',
    basis: 'Income-tax rules: the 7th of the next month (30 April for March)',
  },
  {
    id: 'tds_return',
    title: 'TDS return',
    line: 'Quarterly statement of the TDS you deducted',
    applies: (c) => c.inPlace.has('tax.tan'),
    dates: () => [[1, 31], [5, 31], [7, 31], [10, 31]],
    service_id: 'tax.tds',
    basis: 'Income-tax rules: quarterly, the last day of the month after the quarter (31 May for Q4)',
  },
  {
    id: 'pf_esi',
    title: 'PF and ESI payment',
    line: 'Last month’s PF and ESI contributions',
    applies: (c) => c.inPlace.has('labour.pf') || c.inPlace.has('labour.esi'),
    dates: monthly(15),
    service_id: 'tax.pf_esi_returns',
    basis: 'EPF and ESI schemes: the 15th of the next month',
  },
  {
    id: 'advance_tax',
    title: 'Advance tax instalment',
    line: 'If your tax for the year will be over ₹10,000',
    applies: () => true,
    dates: () => [[3, 15], [6, 15], [9, 15], [12, 15]],
    service_id: 'experts.ca',
    basis: 'Income-tax Act: 15 June, September, December and March',
  },
  {
    id: 'itr',
    title: 'Income tax return',
    line: 'For a business that does not need a tax audit',
    applies: () => true,
    dates: () => [[7, 31]],
    service_id: 'tax.itr_audit',
    basis: 'Income-tax Act: 31 July without an audit, 31 October with one',
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The due dates that apply and fall within `days` of `today` (a 'YYYY-MM-DD' India day).
 * @returns [{ id, title, line, due_on, days_left, service_id, basis }]
 */
function dueWithin(context, today, days) {
  const start = Date.parse(`${today}T00:00:00Z`);
  const year = Number(today.slice(0, 4));
  const out = [];
  for (const entry of CALENDAR) {
    if (!entry.applies(context)) continue;
    for (const y of [year, year + 1]) {
      for (const [m, d] of entry.dates(y)) {
        const at = Date.UTC(y, m - 1, d);
        const left = Math.round((at - start) / DAY_MS);
        if (left >= 0 && left <= days) {
          out.push({
            id: entry.id, title: entry.title, line: entry.line,
            due_on: new Date(at).toISOString().slice(0, 10), days_left: left,
            service_id: entry.service_id, basis: entry.basis,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.days_left - b.days_left);
}

module.exports = { CALENDAR, dueWithin };
