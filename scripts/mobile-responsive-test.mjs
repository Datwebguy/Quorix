/**
 * Mobile responsiveness audit — checks overflow, nav, scroll at 375 / 390 / 768 px.
 * Run: node scripts/mobile-responsive-test.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'mobile-test-screenshots');
const BASE = process.env.TEST_BASE || 'http://localhost:3001';
const WIDTHS = [375, 390, 768];

const PAGES = [
  { name: 'landing', path: '/' },
  { name: 'login', path: '/login' },
  {
    name: 'dashboard',
    path: '/dashboard',
    setup: async (page) => {
      await page.addInitScript(() => {
        localStorage.setItem('operatorWallet', '0xddd6d4fde39e81842f593b33c4ebd5fd3942750f');
        localStorage.setItem('loginType', 'Agentic');
        localStorage.setItem('operatorEmail', 'faizebrand@gmail.com');
      });
    },
  },
];

async function auditPage(page, width) {
  return page.evaluate((w) => {
    const doc = document.documentElement;
    const body = document.body;
    const hOverflow = doc.scrollWidth > w + 2 || body.scrollWidth > w + 2;
    const vScrollable = doc.scrollHeight > window.innerHeight + 8;
    const menuBtn = document.querySelector('.menu-btn, .nav-menu-btn, .bottom-tab-bar');
    const bottomNav = document.querySelector('.bottom-tab-bar');
    const sidebar = document.getElementById('sidebar');
    const drawer = document.getElementById('mobileNavDrawer');
    return {
      hOverflow,
      scrollWidth: Math.max(doc.scrollWidth, body.scrollWidth),
      clientWidth: doc.clientWidth,
      vScrollable,
      scrollHeight: doc.scrollHeight,
      innerHeight: window.innerHeight,
      hasMobileNav: !!(menuBtn || bottomNav || drawer),
      hasBottomNav: !!bottomNav,
      sidebarOffCanvas: sidebar ? getComputedStyle(sidebar).position === 'fixed' : null,
    };
  }, width);
}

async function testDashboardNav(page, width) {
  const results = { drawerOpens: false, bottomTabsWork: false, pagesReachable: [] };

  const menuBtn = page.locator('.menu-btn');
  if (await menuBtn.count()) {
    await menuBtn.click();
    await page.waitForTimeout(300);
    const sidebarOpen = await page.evaluate(() =>
      document.getElementById('sidebar')?.classList.contains('open')
    );
    results.drawerOpens = !!sidebarOpen;
    await page.locator('#sidebarOverlay').click({ force: true }).catch(() => {});
    await page.waitForTimeout(200);
  }

  const tabs = ['overview', 'matching', 'negotiation', 'analytics'];
  for (const tab of tabs) {
    const btn = page.locator(`.bottom-tab-item[data-page="${tab}"]`);
    if (!(await btn.count())) continue;
    await btn.click();
    await page.waitForTimeout(250);
    const active = await page.evaluate((id) => {
      const section = document.getElementById(id);
      return section?.classList.contains('active') ?? false;
    }, tab);
    results.pagesReachable.push({ tab, active });
  }
  results.bottomTabsWork = results.pagesReachable.length >= 4 && results.pagesReachable.every((p) => p.active);

  return results;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    console.log('Chromium bundle missing — falling back to installed Microsoft Edge');
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  }
  const summary = [];

  for (const pg of PAGES) {
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width, height: 812 },
        deviceScaleFactor: 2,
        isMobile: width < 768,
        hasTouch: true,
      });
      const page = await context.newPage();
      if (pg.setup) await pg.setup(page);
      await page.goto(`${BASE}${pg.path}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() =>
        page.goto(`${BASE}${pg.path}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      );
      await page.waitForTimeout(800);

      const audit = await auditPage(page, width);
      let navTest = null;
      if (pg.name === 'dashboard' && width <= 900) {
        navTest = await testDashboardNav(page, width);
      }
      if (pg.name === 'landing' && width <= 960) {
        const drawerBtn = page.locator('.nav-menu-btn');
        if (await drawerBtn.count()) {
          await drawerBtn.click();
          await page.waitForTimeout(300);
          navTest = {
            drawerOpens: await page.evaluate(() =>
              document.getElementById('mobileNavDrawer')?.classList.contains('open')
            ),
          };
          await page.locator('#mobileNavOverlay').click({ force: true }).catch(() => {});
        }
      }

      const shot = join(OUT, `${pg.name}-${width}px.png`);
      await page.screenshot({ path: shot, fullPage: true });

      const url = page.url();
      const onExpectedPage = url.includes(pg.path === '/' ? 'localhost:3001/' : pg.path) && !url.includes('Cannot');
      const needsMobileNav = pg.name === 'dashboard' ? width <= 900 : pg.name === 'landing' ? width <= 960 : false;
      const navOk = !needsMobileNav || (pg.name === 'dashboard' ? (navTest?.drawerOpens && navTest?.bottomTabsWork) : navTest?.drawerOpens);
      const pass = onExpectedPage && !audit.hOverflow && (!needsMobileNav || audit.hasMobileNav) && navOk;

      summary.push({
        page: pg.name,
        width,
        pass,
        url,
        audit,
        navTest,
        screenshot: shot,
      });
      await context.close();
    }
  }

  await browser.close();

  console.log('\n=== MOBILE RESPONSIVE TEST RESULTS ===\n');
  for (const row of summary) {
    const status = row.pass ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${row.page} @ ${row.width}px (${row.url})`);
    console.log(`  horizontal overflow: ${row.audit.hOverflow ? 'YES (BUG)' : 'no'} (scrollW=${row.audit.scrollWidth}, vw=${row.audit.clientWidth})`);
    console.log(`  vertical scroll: ${row.audit.vScrollable ? 'yes' : 'short page'} (${row.audit.scrollHeight}px / ${row.audit.innerHeight}px)`);
    console.log(`  mobile nav present: ${row.audit.hasMobileNav}`);
    if (row.navTest) console.log(`  nav test:`, JSON.stringify(row.navTest));
    console.log(`  screenshot: ${row.screenshot}`);
    console.log('');
  }

  const fails = summary.filter((r) => !r.pass);
  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});