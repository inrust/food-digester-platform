export const dispatchCases: Readonly<Record<string, { profile?: boolean; control?: string; failure?: string }>>;
export const dispatchMarks: readonly string[];
export function partitionDispatch(sample: any, points?: { at: number; bucket: string }[]): any;
export function validateDispatchReceipt(receipt: any): any[];
