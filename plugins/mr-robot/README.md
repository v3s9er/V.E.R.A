# Mr. Robot Page Publisher

페이지 저장, 수정 이력, 복원, 로컬 미리보기와 Cloudflare Worker 패키징을 제공하는 Codex 플러그인입니다. Python 3.10 이상을 사용하며 세 Python 도구는 표준 라이브러리만 필요합니다.

## 공개 범위

이 폴더에는 플러그인 메타데이터, 사용 지침, 재사용 가능한 Python 도구만 공개합니다. 사용자 페이지의 HTML/CSS/JavaScript, 프론트엔드 프로젝트, SVG/이미지, 페이지 이력, 미리보기 산출물, 배포 설정과 자격 증명은 포함하지 않습니다.

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

이 폴더는 `.codex-plugin/plugin.json` 형식의 Codex 플러그인입니다. Mr.Robot 데스크톱 앱의 JavaScript 외부 플러그인과는 설치 형식이 다릅니다.
