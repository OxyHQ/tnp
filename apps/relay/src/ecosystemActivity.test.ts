import { expect, test } from 'bun:test';
import { requestEdgeRegion } from './ecosystemActivity';

test('relay uses the canonical activity region prefix for Cloudflare PoPs', () => {
  expect(requestEdgeRegion(new Headers({ 'cf-ray': '012345-MAD' }))).toBe('edge-mad');
});

test('a visitor country or address cannot become an activity location', () => {
  expect(requestEdgeRegion(new Headers({ 'cf-ipcountry': 'US', 'cf-connecting-ip': '192.0.2.1' }))).toBeUndefined();
  expect(requestEdgeRegion(new Headers({ 'cf-ray': 'invalid' }))).toBeUndefined();
});
