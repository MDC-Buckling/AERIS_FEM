const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err));

  try {
    console.log('Navigating to app...');
    await page.goto('http://localhost:5175', { waitUntil: 'networkidle', timeout: 15000 });

    console.log('App loaded, keeping browser open for manual testing...');
    console.log('Press Ctrl+C to close');

    // Keep the browser open for 5 minutes for manual testing
    await new Promise(resolve => setTimeout(resolve, 300000));

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await browser.close();
  }
})();
