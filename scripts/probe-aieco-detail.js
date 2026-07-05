const https = require('https');

function request(url, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json, text/plain, */*',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: data })
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const urls = [
    'https://www.okx.ai/priapi/v1/aieco/task/job/stats',
    'https://www.okx.ai/priapi/v1/aieco/task/market/stats',
    'https://www.okx.ai/priapi/v1/aieco/task/job/detail?jobId=386788',
    'https://www.okx.ai/priapi/v1/aieco/task/job/detail?taskId=386788',
    'https://www.okx.ai/priapi/v1/aieco/task/job/detail?id=386788',
    'https://www.okx.ai/priapi/v1/aieco/task/job/386788',
    'https://www.okx.ai/priapi/v1/aieco/task/job/public/detail?jobId=386788',
  ];

  for (const url of urls) {
    const r = await request(url);
    console.log('\n===', url, '===');
    console.log('status:', r.status, 'len:', r.body.length);
    console.log('content-type:', r.headers['content-type']);
    console.log(r.body.slice(0, 2000));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});