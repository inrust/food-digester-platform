/** DEC-015@1.0.0 OTA 状态回传冻结策略。 */
export const OTA_STATUS_CHANNEL_POLICY = {
  policyVersion: '1.0.0',
  status: 'frozen',
  channel: {
    topicType: 'ack',
    topicPattern: 'bnx/device/{deviceId}/ack',
    newTopicAllowed: false,
    iotJobsStatusAllowed: false,
  },
  discriminator: {
    field: 'data.objectType',
    commandValue: 'COMMAND',
    otaValue: 'OTA_TARGET',
    commandReference: 'data.commandId',
    otaReference: 'data.otaTargetId',
    mixedFields: 'reject',
  },
  otaStatuses: ['DOWNLOADING', 'INSTALLING', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK'],
  transitions: {
    NOTIFIED: ['DOWNLOADING', 'FAILED'],
    DOWNLOADING: ['INSTALLING', 'FAILED'],
    INSTALLING: ['SUCCEEDED', 'FAILED', 'ROLLED_BACK'],
    SUCCEEDED: ['ROLLED_BACK'],
    FAILED: [],
    ROLLED_BACK: [],
  },
  idempotency: {
    receiptKey: '{deviceId}:ack:{meta.seq}',
    sameTargetAndStatus: 'event-only',
    conflict: 'quarantine',
  },
  consumers: ['CT-02', 'CT-03', 'AUTH-04', 'BE-OTA-03', 'QA-01', 'QA-02', 'QA-03'],
  pendingParameters: [],
} as const;

export type OtaWireStatus = (typeof OTA_STATUS_CHANNEL_POLICY.otaStatuses)[number];

export function isOtaWireStatus(value: string): value is OtaWireStatus {
  return (OTA_STATUS_CHANNEL_POLICY.otaStatuses as readonly string[]).includes(value);
}

export function canTransitionOtaStatus(from: string, to: OtaWireStatus): boolean {
  if (from === to) return true;
  const allowed = OTA_STATUS_CHANNEL_POLICY.transitions[from as keyof typeof OTA_STATUS_CHANNEL_POLICY.transitions];
  return allowed ? (allowed as readonly string[]).includes(to) : false;
}
