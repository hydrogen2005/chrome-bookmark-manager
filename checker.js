export function classifyStatus(status) {
  if (status >= 200 && status < 400) return { kind: 'ok', label: '可访问', detail: `HTTP ${status}` };
  if (status === 404 || status === 410) return { kind: 'broken', label: '失效', detail: `HTTP ${status}` };
  const labels = { 401: '需要登录', 403: '访问受限', 429: '请求过于频繁' };
  return { kind: 'uncertain', label: labels[status] || '待确认', detail: `HTTP ${status}` };
}

export async function checkLink(url, { signal, fetcher = fetch, timeoutMs = 12000 } = {}) {
  if (!/^https?:\/\//i.test(url)) return { kind: 'skipped', label: '不支持检测', detail: '仅检测 HTTP / HTTPS' };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  async function request(method) {
    const response = await fetcher(url, { method, signal: controller.signal, redirect: 'follow', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (response.body) await response.body.cancel();
    return response;
  }
  try {
    let response = await request('HEAD');
    // Some servers reject HEAD or return misleading errors. Verify errors using GET.
    if (response.status >= 400) response = await request('GET');
    return { ...classifyStatus(response.status), checkedAt: Date.now() };
  } catch (error) {
    if (signal?.aborted) return { kind: 'unchecked', label: '已停止', detail: '' };
    return { kind: 'uncertain', label: timedOut ? '请求超时' : '网络错误', detail: timedOut ? '超过等待时间' : '请手动打开确认', checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function collectLinks(node, recursive) {
  const links = [];
  for (const child of node?.children || []) {
    if (child.url) links.push(child);
    else if (recursive) links.push(...collectLinks(child, true));
  }
  return links;
}
