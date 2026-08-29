import { describe, expect, it } from 'vitest';
import { restliValue } from '../src/linkedin/client.js';

describe('restliValue', () => {
  // The expected string mirrors, character class for character class, what a
  // real browser request that returned HTTP 200 encoded. The URN itself is a
  // synthetic stand-in; what matters is which characters survive untouched
  // (base64url's `_` and `-`) and which get percent-encoded.
  it('encodes a profile URN exactly as the browser does', () => {
    const urn = 'urn:li:fsd_profile:ACoAAATESTPROFILE0001_Xy-Zw33kIHTWt1DtMAV6Pg';
    expect(restliValue(urn)).toBe('urn%3Ali%3Afsd_profile%3AACoAAATESTPROFILE0001_Xy-Zw33kIHTWt1DtMAV6Pg');
  });

  it('produces the full variables string from the capture', () => {
    const urn = 'urn:li:fsd_profile:ACoAAATESTPROFILE0001_Xy-Zw33kIHTWt1DtMAV6Pg';
    const built = `(profileUrn:${restliValue(urn)},sectionType:CONTENT_COLLECTIONS_DETAILS)`;
    expect(built).toBe(
      '(profileUrn:urn%3Ali%3Afsd_profile%3AACoAAATESTPROFILE0001_Xy-Zw33kIHTWt1DtMAV6Pg,sectionType:CONTENT_COLLECTIONS_DETAILS)',
    );
  });

  it('escapes compound-key delimiters inside a value', () => {
    expect(restliValue('urn:li:fsd_profilePosition:(ACoAA,123)')).toBe(
      'urn%3Ali%3Afsd_profilePosition%3A%28ACoAA%2C123%29',
    );
  });
});
