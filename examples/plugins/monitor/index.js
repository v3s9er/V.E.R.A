export const plugin = {
  manifest: {
    id: 'monitor',
    name: 'Monitor',
    version: '1.0.0',
    description: '예제 플러그인: 이벤트 구독과 타이머를 사용합니다 (언로드 시 자동 정리).',
  },
  activate(ctx) {
    // Tracked subscription — removed automatically on unload.
    ctx.on('plugins.changed', (list) => {
      ctx.logger.info(`plugins now: ${list.map((p) => p.id).join(', ') || '(none)'}`);
    });
    // Tracked interval — cleared automatically on unload.
    ctx.setInterval(() => ctx.logger.debug('monitor tick'), 5000);
    let ticks = Number(ctx.storage.get('ticks') ?? 0);
    ctx.setInterval(() => {
      ticks += 1;
      ctx.storage.set('ticks', ticks);
    }, 60000);
  },
};
