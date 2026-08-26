import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { MrRobotPlugin } from './loader.js';

function category(path: string, head: Buffer): { category: string; tools: string[]; reason: string } {
  const ext = extname(path).toLowerCase();
  if (head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || ['.exe', '.dll', '.so'].includes(ext)) return { category: 'reversing/pwn', tools: ['file', 'checksec', 'strings', 'gdb', 'radare2', 'pwntools'], reason: '실행 파일 시그니처/확장자' };
  if (['.pcap', '.pcapng'].includes(ext)) return { category: 'forensics/network', tools: ['tshark', 'tcpdump', 'scapy'], reason: '패킷 캡처 파일' };
  if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.wav'].includes(ext)) return { category: 'forensics/stego', tools: ['exiftool', 'binwalk', 'steghide', 'foremost'], reason: '미디어 파일' };
  if (['.zip', '.7z', '.rar', '.tar', '.gz'].includes(ext)) return { category: 'forensics/archive', tools: ['7z', 'binwalk', 'john'], reason: '압축 파일' };
  if (['.py', '.sage', '.pem', '.der'].includes(ext)) return { category: 'crypto', tools: ['python3', 'sympy', 'z3', 'pycryptodome'], reason: '암호/스크립트 파일' };
  return { category: 'general', tools: ['file', 'strings', 'xxd', 'python3'], reason: '일반 파일 분석' };
}

export function createCtfPlugin(): MrRobotPlugin {
  return {
    manifest: {
      id: 'ctf-toolpack', name: 'CTF Toolpack', version: '0.2.0', kind: 'workflow', enabledByDefault: true,
      description: '승인된 워게임 문제를 분류하고 Docker 샌드박스에 필요한 최소 도구·검증 절차를 제안합니다.',
      capabilities: ['ctf.classify', 'ctf.evidence-plan', 'ctf.execution-verification'],
      permissions: ['filesystem.read'],
      dependencies: [{ id: 'docker-sandbox', name: 'Docker Sandbox 플러그인', required: true }],
    },
    activate(ctx) {
      ctx.registerCommand('ctf.inspect', (raw) => {
        const path = resolve(String((raw as { path?: string } | undefined)?.path ?? ''));
        if (!existsSync(path)) throw new Error('문제 파일을 찾을 수 없습니다.');
        const stat = statSync(path);
        const head = stat.isFile() ? readFileSync(path).subarray(0, 4096) : Buffer.alloc(0);
        const result = category(path, head);
        return {
          path, size: stat.size, ...result,
          workflow: ['정적 식별과 메타데이터 수집', '가설을 최소 명령으로 검증', '필요한 경우에만 네트워크/ptrace 별도 승인', '플래그를 실행 결과로 재검증'],
          authorization: '사용자가 소유하거나 명시적으로 허가받은 CTF/워게임 대상에만 사용',
        };
      }, {
        tool: true, destructive: false, description: 'CTF 문제 파일을 토큰 없이 정적으로 분류하고 최소 분석 도구를 고릅니다.',
        toolWhen: (message) => /ctf|워게임|드림핵|pwn|리버싱|포렌식|암호|challenge/i.test(message),
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      });
    },
  };
}
