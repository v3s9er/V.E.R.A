/** Safe provider diagnostics: never echo remote error text, paths or credentials. */
export type CliFailureCode = 'model_unavailable' | 'authentication' | 'usage_limit' | 'context_limit' | 'protocol_capability' | 'request_rejected' | 'turn_failed';
const messages: Record<CliFailureCode, string> = {
  model_unavailable: '선택한 모델을 현재 CLI 계정에서 사용할 수 없습니다. 모델 목록과 계정의 사용 권한을 확인하세요.',
  authentication: '구독 CLI 인증이 필요합니다. CLI에서 로그인 상태를 확인하세요.',
  usage_limit: '구독 공급자의 사용량 또는 요청 한도에 도달했습니다. 초기화 시각을 확인하고 다시 시도하세요.',
  context_limit: '대화가 모델의 문맥 한도를 초과했습니다. 문맥을 줄이거나 새 대화로 이어가세요.',
  protocol_capability: '앱과 CLI의 실행 규격이 맞지 않습니다. 앱·CLI 업데이트가 필요하며 재로그인이나 PC 권한 확대 문제가 아닙니다.',
  request_rejected: '구독 요청이 거부되었습니다. CLI 로그인·모델 권한을 확인하세요.',
  turn_failed: '구독 모델 작업이 완료되지 않았습니다.',
};
export class CliFailure extends Error {
  constructor(readonly code: CliFailureCode) { super(messages[code]); this.name = 'CliFailure'; }
}
export function classifyCliFailure(value: unknown, fallback: CliFailureCode = 'turn_failed'): CliFailure {
  const error = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const message = typeof error.message === 'string' ? error.message.slice(0, 16384) : '';
  const code = typeof error.code === 'string' ? error.code : '';
  const combined = `${code} ${message}`;
  if (/requires experimentalApi capability/i.test(combined)) return new CliFailure('protocol_capability');
  if (/model[_ -](?:not[_ -]found|not[_ -]supported|unavailable)|model.{0,160}(?:not supported|not found|does not exist|do not have access)/i.test(combined)) return new CliFailure('model_unavailable');
  if (/invalid[_ -]api[_ -]key|unauthorized|authentication[_ -](?:error|required)|not logged in|please (?:log|sign) in/i.test(combined)) return new CliFailure('authentication');
  if (/rate[_ -]?limit|usage[_ -]?limit|quota|too many requests/i.test(combined)) return new CliFailure('usage_limit');
  if (/context[_ -](?:length|window)|maximum context|too many tokens/i.test(combined)) return new CliFailure('context_limit');
  return new CliFailure(fallback);
}
