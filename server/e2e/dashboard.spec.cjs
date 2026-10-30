const { expect, test } = require('@playwright/test');

const base = () => process.env.DASH_BASE;
const signIn = async (page, email = 'admin@example.com', password = process.env.DASH_PASSWORD) => {
  await page.goto(base());
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
};

test('anonymous visitors see only the sign-in form', async ({ page }) => {
  await page.goto(base());
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('alice@example.com')).toHaveCount(0);
});

test('wrong password and non-admin accounts are refused', async ({ page, request }) => {
  await signIn(page, 'admin@example.com', 'wrong-wrong-wrong');
  await expect(page.getByTestId('login-error')).toContainText('invalid email or password');
  await expect(page.getByTestId('tile-runs')).toHaveCount(0);

  const res = await request.post(`${base()}/auth/login`, { data: { email: 'alice@example.com', password: process.env.DASH_PASSWORD } });
  expect(res.ok()).toBeTruthy();
  await signIn(page, 'alice@example.com');
  await expect(page.getByTestId('login-error')).toContainText('admins only');
  await expect(page.getByTestId('tile-runs')).toHaveCount(0);
});

test('PRD overview: totals and the risk breakdown', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('tile-runs')).toContainText('2');
  await expect(page.getByTestId('tile-errors')).toContainText('1');
  await expect(page.getByTestId('tile-gates')).toContainText('1');
  await expect(page.getByTestId('tile-agents')).toContainText('1');
  await expect(page.getByTestId('risk-hits')).toContainText('1');
  await expect(page.getByTestId('risk-none')).toContainText('1');
  await expect(page.getByText(/never a guarantee/)).toBeVisible();
});

test('time per stage, errors, and agent failures views', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Time per stage' }).click();
  const row = page.getByTestId('stage-table').getByRole('row', { name: /feasibility/ });
  await expect(row).toContainText('3 min');
  await expect(page.getByTestId('stage-bars')).toContainText('planning');
  await page.getByRole('button', { name: 'Errors', exact: true }).click();
  await expect(page.getByTestId('error-bars')).toContainText('test_failure');
  await page.getByRole('button', { name: 'Agents and retries' }).click();
  await expect(page.getByTestId('agent-table')).toContainText('solution-architect');
  await expect(page.getByTestId('retry-table')).toContainText('implement');
});

test('gates held back show who and why, and the reason is shown as text, not HTML', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Gates', exact: true }).click();
  const row = page.getByTestId('rejection-table').getByRole('row', { name: /alice@example.com/ });
  await expect(row).toContainText('gate_spec');
  await expect(row).toContainText('too broad');
  await expect(row).toContainText('<img src=x');
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});

test('run drill-down shows the event timeline and the risk indicator', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  const runRow = page.getByTestId('run-table').getByRole('row', { name: /run-a/ });
  await expect(runRow.getByTestId('risk')).toHaveText('scrubbed hits');
  await expect(page.getByTestId('run-table').getByRole('row', { name: /run-b/ }).getByTestId('risk')).toHaveText('no hits found');
  await runRow.getByTestId('open-run').click();
  await expect(page.getByTestId('run-meta')).toContainText('alice@example.com');
  await expect(page.getByTestId('event-table')).toContainText('gate_rejected');
  await expect(page.getByTestId('event-table')).toContainText('duration_ms=60000');
});

test('invite flow: create an invite, the invitee joins, and it shows as used', async ({ page, request }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Users and invites' }).click();
  await page.getByLabel('Invite by email').fill('newdev@example.com');
  await page.getByRole('button', { name: 'Create invite' }).click();
  const token = await page.getByTestId('invite-token').innerText();
  expect(token.length).toBeGreaterThan(30);
  await expect(page.getByTestId('invite-table')).toContainText('newdev@example.com');
  await expect(page.getByTestId('invite-table').getByRole('row', { name: /newdev/ })).toContainText('no');

  const accept = await request.post(`${base()}/auth/accept-invite`, { data: { token, password: 'a long enough passphrase' } });
  expect(accept.ok()).toBeTruthy();
  const again = await request.post(`${base()}/auth/accept-invite`, { data: { token, password: 'a long enough passphrase' } });
  expect(again.status()).toBe(400);

  await page.getByRole('button', { name: 'Users and invites' }).click();
  await expect(page.getByTestId('user-table')).toContainText('newdev@example.com');
  await expect(page.getByTestId('invite-table').getByRole('row', { name: /newdev/ })).not.toContainText(/\bno\b/);
});

test('signing out returns to the sign-in form and drops the session', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('tile-runs')).toBeVisible();
  await page.getByTestId('signout').click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
