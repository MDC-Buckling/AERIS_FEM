const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    console.log('1. Navigate to Aeris GUI...');
    await page.goto('http://localhost:5175', { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(1000);

    // Check if we're in pre-mode
    const preModeVisible = await page.locator('text=Pre-Processor').first().isVisible().catch(() => false);
    console.log('Pre-Processor visible:', preModeVisible);

    // Load a test geometry (cylinder)
    console.log('2. Setting up cylinder geometry...');

    // We need to fill in some basic geometry values to test GNIA
    // Let's try to find the geometry section and set R, L, t

    // First, let's look for input fields
    const allInputs = await page.locator('input[type="number"]').count();
    console.log('Found', allInputs, 'number inputs');

    // Take a screenshot of the current state
    await page.screenshot({ path: '/c/Users/loyal/Documents/Aeris/test-gnia-nr-screenshot-1.png' });
    console.log('Screenshot 1 saved');

    // Try to find and click on the GNIA analysis kind
    console.log('3. Selecting GNIA analysis kind...');

    // Look for analysis section or dropdown
    const analysisLabels = await page.locator('text=Analysis').all();
    console.log('Found', analysisLabels.length, '"Analysis" labels');

    // Check for kind dropdown
    const kindSelector = await page.locator('select, button').filter({ hasText: 'kind' }).first().isVisible().catch(() => false);
    if (kindSelector) {
      console.log('Found kind selector');
    }

    // Check for gnaSolver option
    const gnaText = await page.locator('text=gnaSolver').isVisible().catch(() => false);
    console.log('gnaSolver visible:', gnaText);

    // Take another screenshot
    await page.screenshot({ path: '/c/Users/loyal/Documents/Aeris/test-gnia-nr-screenshot-2.png' });
    console.log('Screenshot 2 saved');

    // Try to run solver by finding Run button
    console.log('4. Looking for Run button...');
    const runButton = await page.locator('button').filter({ hasText: 'Run' }).first().isVisible().catch(() => false);
    if (runButton) {
      console.log('Found Run button');
    } else {
      console.log('Run button not found');
    }

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: '/c/Users/loyal/Documents/Aeris/test-gnia-nr-error.png' });
  } finally {
    await browser.close();
  }
})();
