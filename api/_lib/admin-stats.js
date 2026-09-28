// api/admin-stats.js
// Dashboard counters for the admin portal.

import { getApplicationStats, countEnquiries } from './records.js';
import {
  applyCors,
  handlePreflight,
  requireAdmin,
  withErrorHandling,
} from './http.js';

async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');
  if (handlePreflight(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  // Previously this read a `bcci:admin_sessions` hash that admin-auth.js never
  // wrote, so it returned 401 to every valid admin. It now uses the same
  // session store as every other route.
  if (!(await requireAdmin(req, res))) return;

  // Counts cover every application (no 500-row page cap) and never load
  // the document scans; Postgres computes them with a GROUP BY.
  const [appStats, totalEnquiries] = await Promise.all([getApplicationStats({ recent: 5 }), countEnquiries()]);

  const stats = {
    total: appStats.total,
    pending: appStats.pending,
    approved: appStats.approved,
    rejected: appStats.rejected,
    totalEnquiries,
    recentApplications: appStats.recent.map((a) => ({
      id: a.id,
      company: a.company,
      status: a.status,
      submittedAt: a.submittedAt,
    })),
  };

  return res.status(200).json({
    success: true,
    stats,
    applications: appStats.total,
    enquiries: totalEnquiries,
    checkedAt: new Date().toISOString(),
  });
}

export default withErrorHandling('AdminStats', handler);
