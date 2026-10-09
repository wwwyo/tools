import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('the character counter counts Unicode and clears its input', async ({ app, agent, screen }) => {
  await app.open('/');
  await agent.act('Open the 文字数カウンター tool from the tool list.');
  await expect(screen.getByRole('heading', { name: '文字数カウンター', exact: true })).toBeVisible();
  const input = screen.getByPlaceholder('ここにテキストを入力・貼り付け');
  await input.fill('あ😀A');
  await expect(screen.locator('#count-main')).toHaveText('3');
  await screen.getByRole('button', { name: 'クリア', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(screen.locator('#count-main')).toHaveText('0');
});
