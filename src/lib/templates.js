'use strict';

const TEMPLATE_TYPES = [
  'first_reminder',
  'pending_reminder',
  'final_reminder',
  'overdue_reminder',
  'assignment_announcement',
];

const PLACEHOLDERS = ['student_name', 'first_name', 'problem_title', 'difficulty', 'deadline', 'mentor_name', 'squad'];

const DEFAULT_TEMPLATES = {
  first_reminder: {
    name: 'First daily reminder',
    body:
      'Hello {student_name}. This is your daily coding reminder from {mentor_name}. ' +
      'Your problem for today is {problem_title}. Difficulty level: {difficulty}. ' +
      'Your deadline is {deadline}. Please complete your LeetCode problem today. ' +
      'Thank you and happy coding!',
  },
  pending_reminder: {
    name: 'Pending reminder',
    body:
      'Hello {student_name}! Your LeetCode problem, {problem_title}, is still pending. ' +
      'You have not completed it yet. Please open LeetCode and solve it before {deadline}. All the best!',
  },
  final_reminder: {
    name: 'Final deadline reminder',
    body:
      'Hello {student_name}. This is your final reminder for today. {problem_title} is still not solved, ' +
      'and the deadline is {deadline}. There is still time. Please open LeetCode and finish it now. All the best!',
  },
  overdue_reminder: {
    name: 'Overdue reminder',
    body:
      'Hello {student_name}. The deadline for {problem_title} was {deadline}, and it is still not marked as solved. ' +
      'Please complete it as soon as possible. Thank you!',
  },
  assignment_announcement: {
    name: 'Assignment announcement',
    body:
      'Hello {student_name}! A new LeetCode problem has been assigned to you: {problem_title}. ' +
      'Difficulty level: {difficulty}. The deadline is {deadline}. Happy coding!',
  },
};

const MAX_TEMPLATE_LENGTH = 1000;

/** Validate a template body: known placeholders only, sane length. */
function validateTemplate(body) {
  const errors = [];
  const text = String(body || '');
  if (!text.trim()) errors.push('Template cannot be empty');
  if (text.length > MAX_TEMPLATE_LENGTH) errors.push(`Template must be at most ${MAX_TEMPLATE_LENGTH} characters`);
  if (!text.includes('{student_name}') && !text.includes('{first_name}')) {
    errors.push('Template must include {student_name} or {first_name} so every call is personalised');
  }
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    if (!PLACEHOLDERS.includes(m[1])) errors.push(`Unknown placeholder {${m[1]}}`);
  }
  return errors;
}

/** Strip characters that could break speech markup or read badly. */
function cleanValue(v) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f<>{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderTemplate(body, vars) {
  const values = {
    ...vars,
    first_name: vars.first_name || String(vars.student_name || '').trim().split(/\s+/)[0],
  };
  return String(body)
    .replace(/\{([a-z_]+)\}/g, (match, key) => (PLACEHOLDERS.includes(key) ? cleanValue(values[key]) : match))
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { TEMPLATE_TYPES, PLACEHOLDERS, DEFAULT_TEMPLATES, validateTemplate, renderTemplate, cleanValue };
