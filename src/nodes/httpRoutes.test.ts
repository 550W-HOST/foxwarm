import test from 'node:test';
import assert from 'node:assert/strict';
import type express from 'express';
import {
  inferNodeBootstrapBaseUrl,
  NODE_SOURCE_FILES,
  NODE_TEMPLATE_BASE_URL_PLACEHOLDER,
  renderNodeTemplateText,
} from './httpRoutes';

function makeRequest(headers: Record<string, string | string[] | undefined>, protocol = 'http'): Pick<express.Request, 'headers' | 'protocol'> {
  return {
    headers,
    protocol,
  } as Pick<express.Request, 'headers' | 'protocol'>;
}

test('inferNodeBootstrapBaseUrl prefers forwarded proto/host when they are safe', () => {
  const req = makeRequest({
    host: 'internal:3001',
    'x-forwarded-host': 'foxwarm.example.com',
    'x-forwarded-proto': 'https',
  });

  assert.equal(inferNodeBootstrapBaseUrl(req), 'https://foxwarm.example.com');
});

test('inferNodeBootstrapBaseUrl rejects unsafe host values', () => {
  const req = makeRequest({
    host: 'foxwarm.example.com/evil',
    'x-forwarded-proto': 'https',
  });

  assert.equal(inferNodeBootstrapBaseUrl(req), undefined);
});

test('renderNodeTemplateText injects request-derived base url placeholder', () => {
  const req = makeRequest({
    host: '192.168.1.50:3001',
  });

  const rendered = renderNodeTemplateText(`HOST="${NODE_TEMPLATE_BASE_URL_PLACEHOLDER}"`, req);
  assert.equal(rendered, 'HOST="http://192.168.1.50:3001"');
});

test('node source bundle includes shared package artifacts required by runtime', () => {
  assert.equal(NODE_SOURCE_FILES.includes('packages/shared'), true);
  assert.equal(NODE_SOURCE_FILES.includes('packages/cli-node'), true);
});
