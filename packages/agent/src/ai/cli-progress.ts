/** Only public commentary and execution phases; never raw thinking/tool output. */
export function cliProgress(event: Record<string, any>): string | undefined {
  const item = event.item;
  if (item?.type === 'agent_message' && item.phase === 'commentary' && typeof item.text === 'string') return item.text.slice(0, 1000);
  const completed = event.type === 'item.completed';
  switch (item?.type) {
    case 'reasoning': return '요청을 분석하고 있습니다';
    case 'command_execution': return completed ? '명령 실행 결과를 확인하고 있습니다' : '명령을 실행하고 있습니다';
    case 'file_change': return completed ? '파일 변경을 확인하고 있습니다' : '파일을 수정하고 있습니다';
    case 'mcp_tool_call': return completed ? '연결 도구의 결과를 확인하고 있습니다' : '연결된 도구를 사용하고 있습니다';
    case 'web_search': return '자료를 검색하고 있습니다';
  }
  if (event.type === 'turn.started') return '요청을 분석하고 실행 계획을 준비합니다';
  if (event.type === 'turn.completed' || event.type === 'result') return '결과를 정리하고 있습니다';
  if (event.type === 'assistant' && Array.isArray(event.message?.content) && event.message.content.some((part: any) => part.type === 'tool_use')) return '도구를 실행하고 있습니다';
}

export function createCliProgress(onStatus: (status: string) => void): (text: string) => void {
  let buffer = '', dropping = false, previous = '';
  return text => {
    for (const part of text.split(/(?<=\n)/)) {
      if (!dropping) buffer += part;
      if (buffer.length > 64 * 1024) { buffer = ''; dropping = true; }
      if (!part.endsWith('\n')) continue;
      if (!dropping) {
        try {
          const status = cliProgress(JSON.parse(buffer));
          if (status && status !== previous) { previous = status; onStatus(status); }
        } catch { /* Non-JSON logs are not progress or model reasoning. */ }
      }
      buffer = ''; dropping = false;
    }
  };
}
