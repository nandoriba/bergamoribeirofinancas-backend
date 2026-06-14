import { describe, expect, it } from 'vitest';

import { resolveCreditCardReferenceMonth } from './credit-card-invoice';

describe('resolveCreditCardReferenceMonth', () => {
  it('keeps purchases up to closing day in the same reference month', () => {
    expect(resolveCreditCardReferenceMonth({ closingDay: 25 }, new Date('2026-06-25T00:00:00.000Z'))).toEqual(
      new Date('2026-06-01T00:00:00.000Z'),
    );
  });

  it('moves purchases after closing day to the next reference month', () => {
    expect(resolveCreditCardReferenceMonth({ closingDay: 25 }, new Date('2026-06-26T00:00:00.000Z'))).toEqual(
      new Date('2026-07-01T00:00:00.000Z'),
    );
  });

  it('returns null when the card has no closing day', () => {
    expect(resolveCreditCardReferenceMonth({ closingDay: null }, new Date('2026-06-26T00:00:00.000Z'))).toBeNull();
  });
});
