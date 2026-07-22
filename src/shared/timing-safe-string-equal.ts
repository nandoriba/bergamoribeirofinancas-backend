import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function timingSafeStringEqual(expected?: string, received?: string): boolean {
  const expectedValue = expected ?? '';
  const receivedValue = received ?? '';
  const matches = timingSafeEqual(sha256(expectedValue), sha256(receivedValue));

  return expectedValue.length > 0 && receivedValue.length > 0 && matches;
}
