const https = require('https');

function request(url, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*', ...headers },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const home = await request('https://www.okx.ai/tasks');
  console.log('HOME', home.status, 'bytes', home.body.length);

  const pri = [...home.body.matchAll(/\/priapi\/v1\/aieco\/[^"'`\s]+/g)].map((m) => m[0]);
  console.log('\npriapi aieco paths in HTML:', [...new Set(pri)]);

  const next = home.body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (next) {
    const j = JSON.parse(next[1]);
    console.log('\n__NEXT_DATA__ keys:', Object.keys(j));
    const pp = j.props?.pageProps || {};
    console.log('pageProps sample:', JSON.stringify(pp).slice(0, 2500));
  }

  const probes = [
    ['GET', 'https://www.okx.ai/priapi/v1/aieco/task/job/stats'],
    ['GET', 'https://www.okx.com/priapi/v1/aieco/task/job/stats'],
    ['GET', 'https://www.okx.ai/priapi/v1/aieco/task/market/stats'],
    ['GET', 'https://www.okx.ai/priapi/v1/aieco/task/job/detail?jobId=386788'],
    ['GET', 'https://www.okx.ai/priapi/v1/aieco/task/job/detail?taskId=386788'],
    ['POST', 'https://www.okx.ai/priapi/v1/aieco/task/job/search', '{"page":1,"pageSize":2,"status":[0]}'],
    ['POST', 'https://www.okx.com/priapi/v1/aieco/task/job/search', '{"page":1,"pageSize":2,"keyword":"WorldCup"}'],
  ];

  console.log('\n=== API probes ===');
  for (const [method, url, body] of probes) {
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    const r = await request(url, method, body, headers);
    console.log(`\n${method} ${url} -> ${r.status}`);
    console.log(r.body.slice(0, 600));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});