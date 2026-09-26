// api/admin-stats.js
// Dashboard counters for the admin portal.

import { listApplications, countApplications, countEnquiries, STATUS } from './records.js';
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

  // listApplications() defaults to a 500-row page; fetch the real total first
  // so counts and the recent-applications feed never silently drop records
  // once the org passes 500 applications.
  const totalApplications = await countApplications();
  const [applications, totalEnquiries] = await Promise.all([
    totalApplications > 0 ? listApplications({ limit: totalApplications }) : Promise.resolve([]),
    countEnquiries(),
  ]);

  const stats = {
    total: totalApplications,
    pending: applications.filter((a) => a.status === STATUS.PENDING).length,
    approved: applications.filter((a) => a.status === STATUS.APPROVED).length,
    rejected: applications.filter((a) => a.status === STATUS.REJECTED).length,
    totalEnquiries,
    recentApplications: applications.slice(0, 5).map((a) => ({
      id: a.id,
      company: a.company,
      status: a.status,
      submittedAt: a.submittedAt,
    })),
  };

  return res.status(200).json({
    success: true,
    stats,
    applications: applications.length,
    enquiries: totalEnquiries,
    checkedAt: new Date().toISOString(),
  });
}

export default withErrorHandling('AdminStats', handler);
