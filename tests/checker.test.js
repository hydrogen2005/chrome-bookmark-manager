import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLink, classifyStatus, collectLinks } from '../checker.js';

test('only 404 and 410 qualify as broken; restrictions and server failures are uncertain', () => {
  for (const status of [200, 204, 301]) assert.equal(classifyStatus(status).kind, 'ok');
  for (const status of [404, 410]) assert.equal(classifyStatus(status).kind, 'broken');
  for (const status of [401, 403, 405, 429, 500, 503]) assert.equal(classifyStatus(status).kind, 'uncertain');
});
test('HEAD failure gets verified using GET before marking broken', async () => {
  const methods = [];
  const result = await checkLink('https://example.com', { fetcher: async (_, options) => { methods.push(options.method); return new Response(null, { status: options.method === 'HEAD' ? 404 : 200 }); } });
  assert.deepEqual(methods, ['HEAD', 'GET']); assert.equal(result.kind, 'ok');
});
test('confirmed 410 is broken and response streams are cancelled', async () => {
  let cancelled = 0;
  const result = await checkLink('https://example.com', { fetcher: async () => ({ status: 410, body: { cancel: async () => { cancelled++; } } }) });
  assert.equal(result.kind, 'broken'); assert.equal(cancelled, 2);
});
test('unsupported schemes never trigger a network request', async () => {
  for (const url of ['chrome://settings', 'javascript:alert(1)', 'file:///test']) {
    assert.equal((await checkLink(url, { fetcher: () => { throw Error('must not fetch'); } })).kind, 'skipped');
  }
});
test('network errors remain uncertain', async () => {
  assert.equal((await checkLink('https://example.com', { fetcher: async () => { throw new TypeError('Failed to fetch'); } })).kind, 'uncertain');
});
test('timeout and user cancellation have different outcomes', async () => {
  const fetcher = async (_, { signal }) => new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  const timed = await checkLink('https://example.com', { fetcher, timeoutMs: 5 });
  assert.equal(timed.label, '请求超时');
  const controller = new AbortController(); controller.abort();
  assert.equal((await checkLink('https://example.com', { fetcher, signal: controller.signal })).kind, 'unchecked');
});
test('scope includes subfolders only when requested', () => {
  const node = { children: [{ id: '1', url: 'https://a' }, { children: [{ id: '2', url: 'https://b' }] }] };
  assert.deepEqual(collectLinks(node, false).map(x => x.id), ['1']);
  assert.deepEqual(collectLinks(node, true).map(x => x.id), ['1', '2']);
});
