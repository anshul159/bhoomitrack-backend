const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
// No `auth` here on purpose — applied at the mount in server.js (PF-007).
const { ownerOnly, requireApproved } = require('../middleware/roles');
const siteAccess = require('../middleware/siteAccess');
const SitePayment = require('../models/SitePayment');
const Attachment = require('../models/Attachment');
const User = require('../models/User');
const push = require('../utils/push');        // a module, not destructured: tests stand in for it
const { formatRupees } = require('../utils/money');
const { parsePaging, paginate } = require('../utils/pagination');
const { decodeBillImage } = require('../utils/billImage');
const audit = require('../utils/audit');
const {
  ValidationError, writableSite, optionalText, requiredText, vehicleNumber, phoneNumber,
  eventDate, clientRequestId, createOnce, periodFilter, voidHandler,
} = require('../utils/siteRecords');

// Site payments (v2): money paid out at a site, with an optional photo of the bill.
// A record, not a request — see models/SitePayment.js.

/**
 * Tells each owner who asked to hear about payments of this size (v2). Never the
 * person who entered it, and never on a retried submission. Fire-and-forget: a
 * push failure must not touch the response.
 */
async function alertLargePayment(req, payment) {
  const owners = await User.find({
    orgId: req.user.orgId,
    role: { $in: ['owner', 'super_admin'] },
    deletedAt: null,
    _id: { $ne: req.user.id },
    'notificationPrefs.largePaymentAlert': true,
    'notificationPrefs.largePaymentThreshold': { $lte: payment.amount },
  }, 'fcmTokens fcmToken').lean();
  if (owners.length === 0) return;

  await push.sendToUsers(
    owners,
    `${formatRupees(payment.amount)} paid at ${payment.site_name}`,
    `To ${payment.paid_to} · ${SitePayment.CATEGORY_LABELS[payment.category] || payment.category}` +
      ` · recorded by ${payment.recorded_by_name || 'a team member'}`,
    { type: 'large_payment', paymentId: String(payment._id), siteName: payment.site_name }
  );
}

const MAX_AMOUNT = 10_00_00_000; // ₹10 crore — above any single site payment; catches a stray extra zero or three.

const paymentToResponse = (p) => ({
  id: p._id,
  site_id: p.site_id,
  site_name: p.site_name,
  category: p.category,
  amount: p.amount,
  paid_to: p.paid_to,
  payment_mode: p.payment_mode || null,
  reference_no: p.reference_no || '',
  paid_on: p.paid_on,
  note: p.note || '',
  vehicle_number: p.vehicle_number || '',
  driver_name: p.driver_name || '',
  contractor_name: p.contractor_name || '',
  contractor_phone: p.contractor_phone || '',
  bill_attachment_id: p.bill_attachment_id || null,
  has_bill: Boolean(p.bill_attachment_id),
  recorded_by_name: p.recorded_by_name || '',
  recorded_by_role: p.recorded_by_role || '',
  status: p.status,
  void_reason: p.void_reason || '',
  voided_at: p.voided_at || null,
  created_at: p.createdAt,
});

// ─── POST /api/payments ───────────────────────────────────────────────────────
// A manager records for their own site; an owner for any site.
router.post('/', requireApproved, async (req, res) => {
  let attachment = null;
  try {
    const body = req.body || {};
    const requestId = clientRequestId(req);

    // A retry of a payment that already landed: answer before decoding the
    // photo again or storing a second copy of it.
    if (requestId) {
      const existing = await SitePayment.findOne({ orgId: req.user.orgId, client_request_id: requestId });
      if (existing) {
        return res.json({ success: true, message: 'Payment recorded', data: paymentToResponse(existing), idempotent_replay: true });
      }
    }

    const where = await writableSite(req, body.site_name);
    if (where.status) return res.status(where.status).json({ success: false, message: where.message });
    const { site } = where;

    if (!SitePayment.CATEGORIES.includes(body.category)) {
      throw new ValidationError(`Choose what the payment was for (${SitePayment.CATEGORIES.join(', ')})`);
    }
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('Amount must be greater than 0');
    if (amount > MAX_AMOUNT) throw new ValidationError('That amount looks too large. Check for an extra zero.');

    let paymentMode = null;
    if (body.payment_mode !== undefined && body.payment_mode !== null && body.payment_mode !== '') {
      if (!SitePayment.PAYMENT_MODES.includes(body.payment_mode)) {
        throw new ValidationError(`Payment mode must be one of ${SitePayment.PAYMENT_MODES.join(', ')}`);
      }
      paymentMode = body.payment_mode;
    }

    const doc = {
      site_id: site._id,
      site_name: site.name,
      category: body.category,
      amount: Number(amount.toFixed(2)),
      paid_to: requiredText(body.paid_to, 100, 'Paid to'),
      payment_mode: paymentMode,
      reference_no: optionalText(body.reference_no, 60, 'Reference number'),
      paid_on: eventDate(body.paid_on, 'Payment date'),
      note: optionalText(body.note, 500, 'Note'),
      vehicle_number: vehicleNumber(body.vehicle_number, { required: false }),
      driver_name: optionalText(body.driver_name, 100, 'Driver name'),
      contractor_name: optionalText(body.contractor_name, 100, 'Contractor name'),
      contractor_phone: phoneNumber(body.contractor_phone, 'Contractor phone'),
      recorded_by: req.user.id,
      recorded_by_name: req.user.name || '',
      recorded_by_role: req.user.role,
    };

    if (body.bill_image !== undefined && body.bill_image !== null && body.bill_image !== '') {
      const image = decodeBillImage(body.bill_image);
      if (image.error) throw new ValidationError(image.error);
      attachment = await Attachment.create({
        orgId: req.user.orgId,
        site_id: site._id,
        kind: 'bill',
        content_type: image.contentType,
        size: image.buffer.length,
        data: image.buffer,
        uploaded_by: req.user.id,
      });
      doc.bill_attachment_id = attachment._id;
    }

    const { record, replay } = await createOnce(SitePayment, req.user.orgId, requestId, doc);
    if (replay && attachment) {
      // Lost the race to an identical retry: that one's photo is the one kept.
      await Attachment.deleteOne({ _id: attachment._id });
      attachment = null;
    }

    if (!replay) {
      audit.record(req, {
        action: 'payment.record',
        entity: 'payment',
        entity_id: record._id,
        entity_label: `₹${record.amount} to ${record.paid_to}`,
        site_id: site._id,
        site_name: site.name,
        after: { category: record.category, amount: record.amount, has_bill: Boolean(record.bill_attachment_id) },
      });
      alertLargePayment(req, record).catch((err) => console.error('[PAYMENT ALERT]', err.message));
    }

    return res.json({
      success: true,
      message: 'Payment recorded',
      data: paymentToResponse(record),
      ...(replay ? { idempotent_replay: true } : {}),
    });
  } catch (err) {
    // A stored photo with no payment pointing at it is an orphan nobody can see.
    if (attachment) await Attachment.deleteOne({ _id: attachment._id }).catch(() => {});
    if (err instanceof ValidationError) return res.status(400).json({ success: false, message: err.message });
    console.error('[PAYMENT RECORD]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/payments/:site ──────────────────────────────────────────────────
// Newest first, void entries included (shown struck through) so the history is
// complete. `summary` counts recorded entries only. Optional ?from=&to= bound
// both the list and the summary by payment date.
router.get('/:site', siteAccess, async (req, res) => {
  try {
    const filter = { orgId: req.user.orgId, site_id: req.site._id, ...periodFilter(req.query, 'paid_on') };
    const paging = parsePaging(req.query, { defaultLimit: 100 });

    const [result, byCategory] = await Promise.all([
      paginate(SitePayment, filter, paging, { paid_on: -1 }, paymentToResponse),
      SitePayment.aggregate([
        { $match: { ...filter, orgId: new mongoose.Types.ObjectId(String(req.user.orgId)), status: 'recorded' } },
        { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
    ]);

    const summary = {
      total_amount: Number(byCategory.reduce((sum, c) => sum + c.total, 0).toFixed(2)),
      count: byCategory.reduce((sum, c) => sum + c.count, 0),
      by_category: byCategory.map((c) => ({ category: c._id, total: Number(c.total.toFixed(2)), count: c.count })),
    };

    return res.json({ success: true, message: 'OK', ...result, summary });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ success: false, message: err.message });
    console.error('[PAYMENT LIST]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/payments/void/:id ───────────────────────────────────────────────
router.put('/void/:id', ownerOnly, voidHandler(SitePayment, {
  entity: 'payment',
  label: (p) => `₹${p.amount} to ${p.paid_to}`,
  format: paymentToResponse,
}));

module.exports = router;
