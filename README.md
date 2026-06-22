# 캠페인 지표 체크 대시보드 — 배포 가이드

코드는 다 준비되어 있습니다. 아래 6단계만 그대로 따라하시면 실제 웹사이트 URL이 생깁니다.
막히는 단계가 있으면, 그 단계 번호와 화면에 보이는 내용을 그대로 가지고 다시 질문해주세요.

---

## 1단계. GitHub에 새 저장소(repository) 만들기

1. https://github.com 접속 후 로그인
2. 우측 상단 **+** 버튼 → **New repository**
3. Repository name: `campaign-dashboard` (원하는 이름으로 변경 가능)
4. **Public** 또는 **Private** 선택 (둘 다 이후 단계에 영향 없음)
5. 다른 옵션은 그대로 두고 **Create repository** 클릭

---

## 2단계. 이 폴더를 GitHub에 업로드

GitHub 웹사이트에서 직접 업로드하는 방법(터미널 불필요):

1. 방금 만든 저장소 페이지에서 **uploading an existing file** 링크 클릭
   (또는 저장소 페이지 → **Add file** → **Upload files**)
2. 이 프로젝트 폴더 안의 **모든 파일과 폴더**를 그대로 끌어다 놓기
   - `package.json`, `vite.config.js`, `index.html`, `.gitignore`
   - `src/` 폴더 전체
   - `functions/` 폴더 전체
3. 하단에 커밋 메시지(아무 말이나, 예: "first upload") 적고 **Commit changes**

---

## 3단계. Cloudflare Pages 프로젝트 만들기

1. https://dash.cloudflare.com 접속 후 로그인
2. 좌측 메뉴에서 **Workers & Pages** 클릭
3. **Create application** → **Pages** 탭 → **Connect to Git**
4. GitHub 계정 연결 (처음이면 권한 허용 화면이 나옵니다)
5. 방금 만든 `campaign-dashboard` 저장소 선택 → **Begin setup**

---

## 4단계. 빌드 설정 입력

화면에 빈 칸들이 나오는데, 아래와 같이 입력하세요.

| 항목 | 입력값 |
|---|---|
| Framework preset | **Vite** (목록에 있으면 선택, 없으면 None) |
| Build command | `npm run build` |
| Build output directory | `dist` |

입력 후 **Save and Deploy** 클릭. 몇 분 기다리면 빌드가 진행되고, 끝나면 `https://campaign-dashboard-xxx.pages.dev` 같은 URL이 생깁니다.

**이 시점에 사이트가 열리긴 하지만, 아직 예산을 입력해도 저장이 안 됩니다.** (5단계를 마쳐야 저장이 동작합니다)

---

## 5단계. 데이터 저장 공간(KV) 만들고 연결하기

5-1. KV Namespace 만들기
1. Cloudflare 대시보드 좌측 메뉴에서 **Workers & Pages** → **KV** 클릭
2. **Create a namespace** 클릭
3. 이름: `dashboard-storage` 입력 → **Add**

5-2. 방금 만든 Pages 프로젝트에 연결하기
1. **Workers & Pages** → 아까 만든 `campaign-dashboard` 프로젝트 클릭
2. **Settings** 탭 → **Bindings** (또는 **Functions** 안의 **KV namespace bindings**)
3. **Add binding** 클릭
4. Variable name: **`DASHBOARD_KV`** (이 이름을 정확히 똑같이 입력해야 합니다 — 코드에서 이 이름으로 찾습니다)
5. KV namespace: 방금 만든 `dashboard-storage` 선택 → **Save**

5-3. 재배포
- Bindings를 추가한 뒤에는 **다시 배포해야 적용됩니다.**
- **Deployments** 탭 → 가장 최근 배포 옆 **⋯** 메뉴 → **Retry deployment** (또는 새 커밋을 아무거나 만들어서 자동 재배포)

---

## 6단계. 확인

1. 발급된 `https://....pages.dev` 주소로 접속
2. CSV 업로드 → 컬럼 매칭 → 캠페인 예산 입력
3. 페이지를 새로고침(F5)해서, 입력한 예산이 그대로 남아있는지 확인
   - 남아있다면: 저장이 정상 작동하는 것 (5단계 성공)
   - 사라진다면: 5단계의 Variable name(`DASHBOARD_KV`)이 정확한지, 재배포를 했는지 확인

---

## 이후 업데이트할 때

코드를 수정한 새 버전을 받으면:
1. GitHub 저장소 페이지에서 바뀐 파일을 다시 업로드 (같은 경로/이름으로 덮어쓰기)
2. Cloudflare Pages가 GitHub 변경을 감지해서 **자동으로 재배포**합니다 (별도 작업 불필요)

---

## 막혔을 때 자주 발생하는 문제

| 증상 | 원인/해결 |
|---|---|
| 빌드 실패(Build failed) | Build command/Output directory를 4단계와 똑같이 입력했는지 확인 |
| 화면은 뜨는데 새하얗게 비어있음 | 브라우저에서 F12 → Console 탭에 에러 메시지 확인, 그 내용 그대로 가지고 질문 |
| 예산 입력해도 저장 안 됨 | 5단계(KV 바인딩)를 빠뜨렸거나, 바인딩 후 재배포를 안 한 경우가 가장 흔함 |
| "DASHBOARD_KV가 바인딩되지 않았습니다" 에러 | Variable name 철자가 정확히 `DASHBOARD_KV`인지 확인 (대소문자 포함 정확히 일치해야 함) |
