'use strict';

const { zonedTimeToUtc } = require('../lib/time');

const QUERY = `query recent($username: String!, $limit: Int!) {
  recentSubmissionList(username: $username, limit: $limit) { titleSlug statusDisplay timestamp }
}`;

/**
 * Best-effort progress sync from LeetCode's public GraphQL endpoint.
 * Marks a student "solved" when an Accepted submission for the assigned slug exists
 * after the assignment date, or "attempted" when any submission exists.
 * Never downgrades progress. Students without a leetcode_username are skipped.
 */
function createLeetcodeSync({ assignments, timezone, logger, fetchImpl = globalThis.fetch, concurrency = 4 }) {
  async function fetchRecent(username) {
    const res = await fetchImpl('https://leetcode.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com' },
      body: JSON.stringify({ query: QUERY, variables: { username, limit: 20 } }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`LeetCode HTTP ${res.status}`);
    const body = await res.json();
    if (body.errors?.length) throw new Error(body.errors[0].message);
    return body.data?.recentSubmissionList || [];
  }

  /** targets: rows from assignments.findTargets/progress (need student_id, leetcode_username, assignment_id, problem_slug, assigned_date, progress_status). */
  async function syncTargets(targets) {
    const byUser = new Map();
    for (const t of targets) {
      if (!t.leetcode_username || !t.problem_slug || t.progress_status === 'solved') continue;
      if (!byUser.has(t.leetcode_username)) byUser.set(t.leetcode_username, []);
      byUser.get(t.leetcode_username).push(t);
    }
    const result = { checked: 0, solved: 0, attempted: 0, errors: 0 };
    const queue = [...byUser.entries()];
    async function worker() {
      while (queue.length) {
        const [username, rows] = queue.shift();
        try {
          const subs = await fetchRecent(username);
          result.checked++;
          for (const t of rows) {
            const since = zonedTimeToUtc(t.assigned_date, '00:00', timezone).getTime() / 1000;
            const mine = subs.filter((s) => s.titleSlug === t.problem_slug && Number(s.timestamp) >= since);
            if (mine.some((s) => s.statusDisplay === 'Accepted')) {
              assignments.setProgress(t.assignment_id, t.student_id, 'solved', 'leetcode_sync');
              result.solved++;
            } else if (mine.length && t.progress_status === 'not_started') {
              assignments.setProgress(t.assignment_id, t.student_id, 'attempted', 'leetcode_sync');
              result.attempted++;
            }
          }
        } catch (err) {
          result.errors++;
          logger.warn('leetcode sync failed for user', { error: err.message });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return result;
  }

  return { syncTargets, fetchRecent };
}

module.exports = { createLeetcodeSync };
