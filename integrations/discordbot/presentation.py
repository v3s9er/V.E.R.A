"""Human-readable transport results. Never dump a control envelope to Discord."""
import json
import re


def result_text(result, action):
    if isinstance(result, str):
        try:
            envelope = json.loads(result)
            if isinstance(envelope, dict) and set(envelope).issubset({'ok', 'error', 'text', 'message', 'result'}):
                return result_text(envelope, action)
        except (ValueError, TypeError):
            pass
        return result
    if isinstance(result, list) and action == 'models':
        return '\n'.join(f"• {item.get('name', '공급자')} · {item.get('model', '모델 선택 필요')} (ID: {item.get('providerId', '')})" if isinstance(item, dict) else f'• {item}' for item in result) or '사용 가능한 모델이 없습니다.'
    if not isinstance(result, dict):
        return '응답 내용을 받지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.'
    if result.get('error') or result.get('ok') is False:
        error = result.get('error')
        detail = error.get('message') if isinstance(error, dict) else error
        return '⚠️ ' + (str(detail)[:1200] if detail else '작업을 완료하지 못했습니다. 다시 시도하세요.')
    for key in ('text', 'message'):
        if isinstance(result.get(key), str) and result[key].strip():
            return result_text(result[key], action)
    return {'stop': '작업 중지를 요청했습니다.', 'approve': '승인 응답을 전달했습니다.', 'access': 'PC 접근 권한을 변경했습니다.', 'settings': '모델·추론 설정을 저장했습니다.'}.get(action, '작업은 종료됐지만 답변 내용이 없습니다. /robot result로 마지막 결과를 다시 확인하거나 요청을 다시 보내세요.' if action in ('ask', 'result') else '요청을 적용했습니다.')


def wants_files(text):
    return bool(re.search(r'보내|보여.*파일|올려|첨부|다운로드|\b(?:send|upload|attach|download)\b', text, re.I))
