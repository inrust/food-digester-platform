export const CONFIGURATION_V1_POLICY = {
  policyVersion: '1.0.0',
  status: 'frozen',
  snapshotMode: 'FULL',
  unknownFieldDisposition: 'REJECT',
  fields: {
    heartbeatInterval: { type: 'integer', unit: 'seconds', minimum: 10, maximum: 900, default: 60 },
    telemetryInterval: { type: 'integer', unit: 'seconds', minimum: 5, maximum: 3600, default: 30 },
    cameraRefreshInterval: { type: 'integer', unit: 'minutes', minimum: 1, maximum: 1440, default: 1 },
    temperatureThreshold: { type: 'number', unit: 'celsius', minimum: 0, maximum: 120, default: 80 },
  },
  excludedCandidateFields: ['image', 'rotation', 'motor', 'heating', 'language', 'cloudDomain', 'ntpServer'],
  consumers: ['CT-03', 'BE-CFG-01', 'BE-SYNC-01', 'FE-09', 'QA-02'],
} as const;

export type ConfigurationV1Field = keyof typeof CONFIGURATION_V1_POLICY.fields;
