// api/membership-plans.js
// Membership types offered on the application form.
// Public listing; admin-only create and delete.

import {
  applyCors,
  handlePreflight,
  requireAdmin,
  str,
  withErrorHandling,
} from './_lib/http.js';
import {
  getMembershipPlans,
  createMembershipPlan,
  removeMembershipPlan,
  PlanError,
} from './_lib/membership-plans.js';

/** Sends a PlanError as its own status; anything else is rethrown as a 500. */
function sendPlanError(res, err) {
  if (err instanceof PlanError) {
    return res.status(err.status).json({ success: false, error: err.message });
  }
  throw err;
}

async function handler(req, res) {
  applyCors(req, res, 'GET, POST, DELETE, OPTIONS');
  if (handlePreflight(req, res)) return;

  // ── GET — every plan an applicant can choose (public) ─────────────
  if (req.method === 'GET') {
    const plans = await getMembershipPlans();
    return res.status(200).json({ success: true, plans });
  }

  // ── POST — add a membership type (admin only) ─────────────────────
  if (req.method === 'POST') {
    const adminEmail = await requireAdmin(req, res);
    if (!adminEmail) return;

    const body = req.body || {};
    try {
      const plan = await createMembershipPlan({ name: str(body.name, 200), fee: str(body.fee, 20) }, adminEmail);
      console.log(`[Membership Plans] ${adminEmail} added "${plan.label}"`);
      return res.status(201).json({ success: true, message: 'Membership type added.', plan });
    } catch (err) {
      return sendPlanError(res, err);
    }
  }

  // ── DELETE — remove an admin-added membership type (admin only) ───
  if (req.method === 'DELETE') {
    const adminEmail = await requireAdmin(req, res);
    if (!adminEmail) return;

    const id = str(req.query?.id || req.body?.id, 100);
    try {
      await removeMembershipPlan(id);
      console.log(`[Membership Plans] ${adminEmail} deleted "${id}"`);
      return res.status(200).json({ success: true, message: 'Membership type deleted.' });
    } catch (err) {
      return sendPlanError(res, err);
    }
  }

  return res.status(405).json({ success: false, error: 'Method not allowed.' });
}

export default withErrorHandling('MembershipPlans', handler);
