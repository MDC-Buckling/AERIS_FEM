const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // 1. Navigate to Aeris GUI
    console.log('1. Navigating to http://localhost:5175...');
    await page.goto('http://localhost:5175', { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(1000);

    // 2. Click on "Load Results" or navigate to the post-processor
    // First, check if we need to switch to post mode
    console.log('2. Checking for Post-Processor mode...');

    // Look for any results panel or button to load results
    // In the Aeris GUI, there should be a way to load past results
    // Let's try clicking on the results tab/panel if visible

    // Try to find and click on a recent result - look for nr_test_3
    console.log('3. Looking for nr_test_3 result to load...');

    // First, let's check what's on the page
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('Page content (first 500 chars):', bodyText.substring(0, 500));

    // Try to find a "Post" mode button or Results panel
    const postButton = await page.locator('button:has-text("Post")').first().isVisible().catch(() => false);
    if (postButton) {
      console.log('Found Post button, clicking...');
      await page.click('button:has-text("Post")');
      await page.waitForTimeout(500);
    }

    // Look for job picker dropdown and select nr_test_3
    console.log('3b. Opening jobs dropdown...');
    const jobsDropdown = await page.locator('text=(pick a job)').first().isVisible().catch(() => false);
    if (jobsDropdown) {
      await page.click('text=(pick a job)');
      await page.waitForTimeout(500);

      // Now look for nr_test_3 in the dropdown
      const nr_test_3_visible = await page.locator('text=nr_test_3').first().isVisible().catch(() => false);
      if (nr_test_3_visible) {
        console.log('Found nr_test_3 in dropdown, clicking...');
        await page.click('text=nr_test_3');
        await page.waitForTimeout(1000);
      } else {
        console.log('nr_test_3 not found in dropdown, checking available jobs...');
        const jobsList = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('button, div')).filter(el => {
            const text = el.textContent || '';
            return text.includes('test') || text.includes('job');
          }).map(el => el.textContent).slice(0, 5);
        });
        console.log('Available jobs:', jobsList);
      }
    }

    // 4. Click on "Load-Deflection Path (arc-length)" in Results panel
    console.log('4. Looking for Load-Deflection Path item in Results panel...');
    const chartItemVisible = await page.locator('text=Load-Deflection Path').first().isVisible().catch(() => false);

    if (chartItemVisible) {
      console.log('✓ Found "Load-Deflection Path (arc-length)" item');
      await page.click('text=Load-Deflection Path');
      await page.waitForTimeout(500);

      // 5. Verify chart section appears in Inspector panel
      console.log('5. Checking Inspector panel for chart data...');

      const chartHeader = await page.locator('text=load-deflection').first().isVisible().catch(() => false);
      const stepsLabel = await page.locator('text=steps:').first().isVisible().catch(() => false);
      const lambdaLabel = await page.locator('text=λ_max:').first().isVisible().catch(() => false);

      if (chartHeader && stepsLabel && lambdaLabel) {
        console.log('✓ Chart section visible in Inspector');

        // Get the actual values displayed
        const chartText = await page.evaluate(() => {
          const section = Array.from(document.querySelectorAll('*')).find(el => el.textContent?.includes('load-deflection'));
          return section?.textContent || 'N/A';
        });
        console.log('Chart data:', chartText.substring(0, 200));

        // 6. Verify 3D controls are hidden
        const viewHeader = await page.locator('text=view').nth(0).isVisible().catch(() => false);
        if (!viewHeader) {
          console.log('✓ 3D VIEW section is hidden (as expected)');
        } else {
          console.log('⚠ 3D VIEW section is still visible (should be hidden)');
        }

        console.log('\n✅ CHART DISPLAY TEST PASSED');
      } else {
        console.log('❌ Chart section NOT visible in Inspector');
        console.log('  - chartHeader:', chartHeader);
        console.log('  - stepsLabel:', stepsLabel);
        console.log('  - lambdaLabel:', lambdaLabel);

        // Debug: show what's in the Inspector panel
        const inspectorText = await page.evaluate(() => {
          const inspector = document.querySelector('[class*="Inspector"]') ||
                          Array.from(document.querySelectorAll('*')).find(el => el.textContent?.includes('INSPECTOR'));
          return inspector?.textContent || 'Inspector not found';
        });
        console.log('Inspector content:', inspectorText.substring(0, 300));
      }
    } else {
      console.log('⚠ Could not find "Load-Deflection Path" item in Results panel');
      console.log('Checking visible text...');
      const allText = await page.evaluate(() => document.body.innerText);
      console.log('Full page text preview:', allText.substring(0, 1000));
    }

    // Take a screenshot for visual verification
    console.log('\n6. Taking screenshot...');
    await page.screenshot({ path: 'C:\\Users\\loyal\\Documents\\Aeris\\chart-test-screenshot.png' });
    console.log('Screenshot saved to: chart-test-screenshot.png');

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: 'C:\\Users\\loyal\\Documents\\Aeris\\chart-test-error.png' });
    console.log('Error screenshot saved');
  } finally {
    await browser.close();
  }
})();
