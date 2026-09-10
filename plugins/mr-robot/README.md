# Mr. Robot Page Publisher

페이지 저장, 수정 이력, 복원, 로컬 미리보기와 Cloudflare Worker 패키징을 제공하는 Mr.Robot 데스크톱 모듈입니다. `index.mjs`가 앱의 플러그인 관리자에 연결하며 기존 Codex 사용 지침도 함께 제공합니다. Python 3.10 이상을 사용하며 세 Python 도구는 표준 라이브러리만 필요합니다.

## 앱 연결과 OFF 상태

이 소스의 데스크톱 패키지는 시작할 때 `페이지 게시 · Page Publisher`를 개발 카테고리에 장착합니다. 기본값은 **OFF**입니다. 켜짐/꺼짐은 앱의 호스트 설정에 저장되므로 재시작해도 선택을 유지합니다. OFF 상태에서 장착만 하면 Python 실행, 페이지 읽기/저장, 미리보기 서버, 네트워크 게시가 시작되지 않습니다.

플러그인을 켠 뒤 `page-publisher.list`, `show`, `history`, `save`, `restore-revision`, `delete`, `restore`, `build`, `preview.start`, `preview.stop` 명령을 사용합니다. 명령은 `page-publisher.` 접두사를 사용하며 관리자와 기존 변경 승인 정책을 적용합니다. OFF로 전환하면 진행 중인 작업과 미리보기를 중지하고 대기 작업도 취소합니다.

`page-publisher.status`와 `page-publisher.config.get`은 꺼진 상태에서도 조회할 수 있습니다. Python 경로가 필요한 경우 `page-publisher.config.set`의 `pythonPath`에 실행 파일의 절대 경로를 설정하세요. 이 설정도 실행 파일을 즉시 시작하지 않습니다.

## 공개 범위

이 폴더에는 서버 측 Node.js 어댑터와 테스트, 플러그인 메타데이터, 사용 지침, 재사용 가능한 Python 도구만 공개합니다. 사용자 페이지의 HTML/CSS/JavaScript, 프론트엔드 프로젝트, SVG/이미지, 페이지 이력, 미리보기 산출물, 배포 설정과 자격 증명은 포함하지 않습니다.

`build_worker.py` 안의 JavaScript는 HTTP 요청을 처리하는 서버 측 Worker 템플릿입니다. 사용자 페이지는 빌드할 때만 입력받으며 이 소스에 내장되어 있지 않습니다. 생성된 `worker.mjs`에는 페이지 내용이 포함되므로 Git에 올리면 안 됩니다. `wrangler.jsonc`, `build-manifest.json`도 로컬에만 보관하세요.

폴더의 `.gitignore`는 공개 파일을 정확한 허용 목록으로 제한합니다. 새 도구를 공개할 때만 목록을 갱신하고, 페이지 파일을 강제로 추가하는 `git add -f`는 사용하지 마세요. 페이지 원본과 빌드 출력은 저장소 밖에 두세요.

## 저장과 사용

기본 페이지 라이브러리는 사용자 홈의 `.mr-robot` 아래 `sites/`와 `trash/`입니다. `MR_ROBOT_HOME` 또는 `site_manager.py --root <library-path>`로 다른 로컬 위치를 선택할 수 있습니다.

```text
python scripts/site_manager.py list --json
python scripts/site_manager.py save <site> <local-source-path> --title <title>
python scripts/site_manager.py history <site>
python scripts/serve_preview.py <local-source-path>
python scripts/build_worker.py <local-source-path> --output <local-output-path> --name <worker-name>
```

저장·복원·패키징은 자동으로 배포하지 않습니다. Cloudflare 게시에는 별도의 Wrangler 설치·인증과 사용자의 게시 요청이 필요합니다. 세부 절차는 [페이지 게시 지침](skills/page-publisher/SKILL.md)과 [저장 및 게시](skills/page-publisher/references/storage-and-publishing.md)를 참고하세요.

개발 중 수동 장착은 앱의 외부 플러그인 경로에 이 폴더 또는 `index.mjs`를 지정하면 됩니다. `.codex-plugin/plugin.json`은 별도의 Codex 설치용 메타데이터이며 데스크톱 앱 장착에는 Codex 설치가 필요하지 않습니다.

어댑터 검증: `node --test plugins/mr-robot/test/native-adapter.test.mjs` (저장소 루트에서 실행).
