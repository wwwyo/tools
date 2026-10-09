import { randomUUID } from 'node:crypto';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';

const apiKey = process.env.OPENCODE_API_KEY;
if (!apiKey) {
  throw new Error('OPENCODE_API_KEY is required; run through mise with age decryption enabled.');
}
const model = process.env.OPENCODE_E2E_MODEL;
if (!model) {
  throw new Error('OPENCODE_E2E_MODEL is required; use the shared mise setting.');
}
if (process.env.E2E_TELEMETRY_DISABLED !== '1') {
  throw new Error('Set E2E_TELEMETRY_DISABLED=1 before starting e2e.');
}

const go = createOpenAICompatible({
  name: 'opencode-go',
  baseURL: 'https://opencode.ai/zen/go/v1',
  apiKey,
  supportsStructuredOutputs: true,
  headers: {
    'User-Agent': 'wwwyo-e2e/0.1',
    'x-opencode-session': randomUUID(),
  },
});

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [
    {
      engine: web(),
      app: {
        url: 'http://127.0.0.1:0',
        command: { executable: 'bun', args: ["run", "dev", "--host", "127.0.0.1", "--port", "{port}"], log: '.e2e/logs/app.log' },
      },
    },
  ],
  agents: {
    default: {
      model: go(model),
      system: 'Verify every goal on screen. Create and clean up your own test data.',
      maxSteps: 15,
      maxModelCalls: 15,
    },
  },
} satisfies E2EConfig;
