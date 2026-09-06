// Test only: real installed Codex, synthetic local HTTP provider, no account use.
import { spawn } from 'node:child_process';
const settings = {
  model_provider: 'fixture', 'model_providers.fixture.name': 'fixture',
  'model_providers.fixture.base_url': `http://127.0.0.1:${process.env.MRROBOT_FIXTURE_PORT}/v1`,
  'model_providers.fixture.wire_api': 'responses',
  'model_providers.fixture.requires_openai_auth': false,
};
const child = spawn(process.env.MRROBOT_FIXTURE_COMMAND, [...JSON.parse(process.env.MRROBOT_FIXTURE_PREFIX), ...process.argv.slice(2), ...Object.entries(settings).flatMap(([k, v]) => ['-c', `${k}=${JSON.stringify(v)}`])], { stdio: 'inherit', windowsHide: true });
child.on('error', () => process.exit(1));
child.on('close', code => process.exit(code ?? 1));
