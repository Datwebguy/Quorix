const https = require('https');

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*', ...headers } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      })
      .on('error', reject);
  });
}

(async () => {
  const home = await get('https://www.okx.ai/tasks');
  console.log('HOME status:', home.status, 'bytes:', home.body.length);

  const scriptSrcs = [...home.body.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  console.log('script tags:', scriptSrcs.length);

  const allPaths = new Set();
  const allUrls = new Set();

  for (const s of scriptSrcs.slice(0, 12)) {
    const url = s.startsWith('http') ? s : `https://www.okx.ai${s}`;
    try {
      const js = await get(url);
      const paths = js.body.match(/["'`]\/priapi\/[^"'`\s]+/g) || [];
      const paths2 = js.body.match(/["'`]\/api\/[^"'`\s]+/g) || [];
      const urls = js.body.match(/https?:\/\/[^"'`\s]+/g) || [];
      for (const p of [...paths, ...paths2]) allPaths.add(p.replace(/["'`]/g, ''));
      for (const u of urls)
        if (/api|task|market|agent|job/i.test(u)) allUrls.add(u.split('\\')[0]);
      if (paths.length || paths2.length) console.log('\nBundle:', url.slice(-60));
    } catch (e) {
      console.log('fail bundle', url, e.message);
    }
  }

  console.log('\n=== Discovered /priapi and /api paths (sample) ===');
  [...allPaths].sort().slice(0, 60).forEach((p) => console.log(p));

  console.log('\n=== Discovered external URLs (sample) ===');
  [...allUrls].sort().slice(0, 30).forEach((u) => console.log(u));

  const probes = [
    'https://www.okx.com/priapi/v1/dapp/task/list',
    'https://www.okx.com/priapi/v1/dapp/task/detail?taskId=386788',
    'https://www.okx.com/priapi/v1/dapp/task/market/list',
    'https://www.okx.com/priapi/v1/dapp/marketplace/task/list',
    'https://www.okx.com/priapi/v1/ai/agent/task/list',
    'https://web3.okx.com/priapi/v1/dapp/task/list',
  ];
  console.log('\n=== API probe results ===');
  for (const u of probes) {
    try {
      const r = await get(u, { Accept: 'application/json' });
      console.log(r.status, u);
      console.log(r.body.slice(0, 500));
    } catch (e) {
      console.log('ERR', u, e.message);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});