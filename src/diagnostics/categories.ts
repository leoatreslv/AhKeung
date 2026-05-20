// Single source of truth for log category names. Anywhere that calls
// `log.warn/info/error` takes a Category typed value, so a typo at the
// call site becomes a compile error rather than fragmenting the buffer.
//
// Add a category here when you find yourself wanting a new namespace.
// Keep names short — they're displayed in the diagnostics panel.

export const CATEGORY = {
  sync:                 'sync',
  auth:                 'auth',
  invite:               'invite',
  share:                'share',
  exercise:             'exercise',
  bundle:               'bundle',
  onboarding:           'onboarding',
  settings:             'settings',
  uncaught:             'uncaught',
  'unhandled-rejection': 'unhandled-rejection',
  'image-upload':       'image-upload',
} as const;

export type Category = typeof CATEGORY[keyof typeof CATEGORY];
