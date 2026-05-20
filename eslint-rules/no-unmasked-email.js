// Custom ESLint rule (per docs/logging-plan.md S6): inside calls to
// `log.info(...)`, `log.warn(...)`, or `log.error(...)`, flag any
// `email:` property in the context object whose value isn't either a
// `maskEmail(...)` call or a string literal that already looks masked
// (matches /^[^@]*\*+@/).
//
// The rule is scoped to log call sites specifically — not every
// object literal in the codebase — so the false-positive surface is
// minimal. Non-log code that has its own `email` field (e.g. the
// Edge Function body, test fixtures, the Invitation interface)
// isn't affected.
//
// Disable per line with:
//   // eslint-disable-next-line local/no-unmasked-email
// for the rare case where you genuinely want to log an unmasked
// email (you almost never do).

const LOG_METHODS = new Set(['info', 'warn', 'error']);

function looksAlreadyMasked(value) {
  // e.g. 'l**@reslv.io'
  return typeof value === 'string' && /^[^@]*\*+@/.test(value);
}

function isAllowedEmailValue(v) {
  if (!v) return true;
  // maskEmail(...) call.
  if (
    v.type === 'CallExpression'
    && v.callee.type === 'Identifier'
    && v.callee.name === 'maskEmail'
  ) return true;
  // Literal string already in masked form.
  if (v.type === 'Literal' && looksAlreadyMasked(v.value)) return true;
  // Template literal whose first quasi is already masked.
  if (
    v.type === 'TemplateLiteral'
    && v.quasis.length > 0
    && looksAlreadyMasked(v.quasis[0].value.raw)
  ) return true;
  return false;
}

function inspectObjectLiteral(node, context) {
  if (!node || node.type !== 'ObjectExpression') return;
  for (const prop of node.properties) {
    if (prop.type !== 'Property') continue;
    const keyName =
      prop.key.type === 'Identifier' ? prop.key.name
      : prop.key.type === 'Literal'  ? String(prop.key.value)
      : null;
    if (keyName !== 'email') continue;
    if (isAllowedEmailValue(prop.value)) continue;
    context.report({ node: prop, messageId: 'unmasked' });
  }
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow logging unmasked emails. Inside log.info/warn/error context arguments, wrap user-supplied emails with maskEmail(...).',
    },
    schema: [],
    messages: {
      unmasked:
        'email field in a log context must be wrapped with maskEmail(...) (or already masked).',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        // Match `log.info(...)`, `log.warn(...)`, `log.error(...)`.
        const callee = node.callee;
        if (
          callee.type !== 'MemberExpression'
          || callee.object.type !== 'Identifier'
          || callee.object.name !== 'log'
          || callee.property.type !== 'Identifier'
          || !LOG_METHODS.has(callee.property.name)
        ) return;

        // log.info/warn(category, message, context?) — context is arg 2.
        // log.error(category, message, contextOrError?) — same slot.
        const ctxArg = node.arguments[2];
        inspectObjectLiteral(ctxArg, context);
      },
    };
  },
};

export default {
  rules: {
    'no-unmasked-email': rule,
  },
};
