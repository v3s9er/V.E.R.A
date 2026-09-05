import assert from 'node:assert/strict';
import { ChatRunAdmissionPolicy, QUESTION_TOKEN_LIMITS } from '../src/server/server.js';
import { canUseAuditOnly } from '../src/server/ws.js';
const auth = { isAdmin: false, linkId: 'question-budget-fixture', permissionCap: 'ask' as const };
const policy = new ChatRunAdmissionPolicy({ linkedStartsPerWindow: 100, globalStartsPerWindow: 100 });
const profile = { tokenPolicy: 'economy' as const, complexity: 0, executionMode: 'single' as const, reasoningEffort: 'auto' as const, plannedModelCalls: 1, hasTools: false, inputBytes: 0 };
for (const [mode, limit] of Object.entries(QUESTION_TOKEN_LIMITS)) {
  const first = policy.acquire(auth);
  first.configureModelBudget({ ...profile, tokenPolicy: mode as keyof typeof QUESTION_TOKEN_LIMITS });
  assert.equal(first.tokenBudget, limit);
  first.reserveModelCall('api', limit).finish({ promptTokens: limit, completionTokens: 0 });
  assert.throws(() => first.reserveModelCall('api', 1), /질문/);
  first.finish({ promptTokens: limit, completionTokens: 0 });
  const next = policy.acquire(auth);
  next.configureModelBudget({ ...profile, tokenPolicy: mode as keyof typeof QUESTION_TOKEN_LIMITS });
  assert.equal(next.tokenBudget, limit, 'every question gets a fresh budget');
  assert.equal(next.reserveModelCall('api', limit).finish({ promptTokens: 10, completionTokens: 0 }), true);
  next.finish({ promptTokens: 10, completionTokens: 0 });
}
assert.equal(canUseAuditOnly({ state: { auth } } as any), true);
assert.equal(canUseAuditOnly({ state: { auth: { ...auth, permissionCap: 'read-only' } } } as any), false);
const unlimited = policy.acquire(auth, { allowAuditOnly: true });
unlimited.configureModelBudget({ ...profile, tokenPolicy: 'audit-only' });
assert.equal(unlimited.tokenBudget, Number.MAX_SAFE_INTEGER);
assert.equal(unlimited.reserveModelCall('native', Number.MAX_SAFE_INTEGER).finish({ promptTokens: 30_000_000, completionTokens: 1000 }), true);
unlimited.finish({ promptTokens: 30_000_000, completionTokens: 1000 });
console.log('Question budgets passed: three levels, fresh question reset, authenticated unlimited native use, read-only denial');
