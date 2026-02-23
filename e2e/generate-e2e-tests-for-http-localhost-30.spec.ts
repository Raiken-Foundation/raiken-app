import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

test.describe('About Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/about`);
  });

  test('should display page header and subtitle', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'About', level: 1 })).toBeVisible();
    await expect(page.getByText('Learn more about the Raiken Playground')).toBeVisible();
  });

  test('should display mission section with content', async ({ page }) => {
    const missionSection = page.getByTestId('about-mission');
    await expect(missionSection).toBeVisible();
    await expect(missionSection.getByRole('heading', { name: 'Our Mission', level: 2 })).toBeVisible();
    await expect(missionSection.getByText(/multi-page test application/i)).toBeVisible();
  });

  test('should display all feature items', async ({ page }) => {
    const featuresSection = page.getByTestId('about-features');
    await expect(featuresSection).toBeVisible();
    await expect(featuresSection.getByRole('heading', { name: 'Features', level: 2 })).toBeVisible();

    await expect(page.getByTestId('feature-item-auth')).toBeVisible();
    await expect(page.getByTestId('feature-item-auth')).toContainText('Authentication');
    
    await expect(page.getByTestId('feature-item-dashboard')).toBeVisible();
    await expect(page.getByTestId('feature-item-dashboard')).toContainText('Dashboard');
    
    await expect(page.getByTestId('feature-item-profile')).toBeVisible();
    await expect(page.getByTestId('feature-item-profile')).toContainText('Profile');
    
    await expect(page.getByTestId('feature-item-settings')).toBeVisible();
    await expect(page.getByTestId('feature-item-settings')).toContainText('Settings');
    
    await expect(page.getByTestId('feature-item-contact')).toBeVisible();
    await expect(page.getByTestId('feature-item-contact')).toContainText('Contact');
  });

  test('should display technology stack badges', async ({ page }) => {
    const techSection = page.getByTestId('about-tech');
    await expect(techSection).toBeVisible();
    await expect(techSection.getByRole('heading', { name: 'Technology Stack', level: 2 })).toBeVisible();

    await expect(page.getByTestId('badge-react')).toBeVisible();
    await expect(page.getByTestId('badge-react')).toHaveText('React 18');
    
    await expect(page.getByTestId('badge-router')).toBeVisible();
    await expect(page.getByTestId('badge-router')).toHaveText('React Router');
    
    await expect(page.getByTestId('badge-ts')).toBeVisible();
    await expect(page.getByTestId('badge-ts')).toHaveText('TypeScript');
    
    await expect(page.getByTestId('badge-vite')).toBeVisible();
    await expect(page.getByTestId('badge-vite')).toHaveText('Vite');
    
    await expect(page.getByTestId('badge-pw')).toBeVisible();
    await expect(page.getByTestId('badge-pw')).toHaveText('Playwright');
  });

  test('should display team members', async ({ page }) => {
    const teamSection = page.getByTestId('about-team');
    await expect(teamSection).toBeVisible();
    await expect(teamSection.getByRole('heading', { name: 'Team', level: 2 })).toBeVisible();

    const member1 = page.getByTestId('team-member-1');
    await expect(member1).toBeVisible();
    await expect(member1.getByRole('heading', { name: 'Raiken Bot', level: 4 })).toBeVisible();
    await expect(member1.getByText('QA Agent')).toBeVisible();

    const member2 = page.getByTestId('team-member-2');
    await expect(member2).toBeVisible();
    await expect(member2.getByRole('heading', { name: 'Developer', level: 4 })).toBeVisible();
    await expect(member2.getByText('Human in the loop')).toBeVisible();
  });

  test('should navigate to contact page via footer link', async ({ page }) => {
    await page.getByTestId('about-contact-link').click();
    await expect(page).toHaveURL(`${BASE}/contact`);
  });

  test('should navigate to home page via footer link', async ({ page }) => {
    await page.getByTestId('about-home-link').click();
    await expect(page).toHaveURL(`${BASE}/`);
  });

  test('should navigate to home via brand link in header', async ({ page }) => {
    await page.getByTestId('brand-link').click();
    await expect(page).toHaveURL(`${BASE}/`);
  });

  test('should have correct page structure and layout', async ({ page }) => {
    const aboutPage = page.getByTestId('about-page');
    await expect(aboutPage).toBeVisible();

    const sections = [
      page.getByTestId('about-mission'),
      page.getByTestId('about-features'),
      page.getByTestId('about-tech'),
      page.getByTestId('about-team')
    ];

    for (const section of sections) {
      await expect(section).toBeVisible();
    }
  });
});
