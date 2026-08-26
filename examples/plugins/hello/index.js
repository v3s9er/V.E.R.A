export const plugin = {
  manifest: {
    id: 'hello',
    name: 'Hello',
    version: '1.0.0',
    description: '예제 플러그인: 인사 명령을 등록합니다.',
  },
  activate(ctx) {
    ctx.logger.info('hello activated');
    ctx.registerCommand(
      'hello.greet',
      (params) => ({ reply: `Hello, ${params?.name ?? 'world'}!` }),
      { description: '인사하기', tool: true },
    );
    ctx.storage.set('activatedAt', Date.now());
  },
  deactivate(ctx) {
    ctx.logger.info('hello deactivated');
  },
};
