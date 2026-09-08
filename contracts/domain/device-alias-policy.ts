export const DEVICE_ALIAS_POLICY = {
  policyVersion: '1.0.0',
  status: 'frozen',
  trim: true,
  unicodeNormalization: 'NFC',
  caseSensitivity: 'SENSITIVE',
  minimumLength: 1,
  maximumLength: 64,
  uniquenessScope: 'CUSTOMER_INCLUDING_UNASSIGNED',
  nullDisposition: 'CLEAR',
  consumers: ['BE-DEV-06', 'FE-07', 'QA-06'],
} as const;
