# 공연 자막 프로토타입 (무대 1스크린 + 관객 모바일 + 오퍼레이터)
- 무대 스크린: EN + DE (2줄 고정)
- 모바일: EN + 관객이 선택한 언어
- 오퍼레이터: 한국어 큐를 보고 NEXT/PREV/JUMP, 라이브 타이핑
- 자동번역: 필요할 때만 API 호출(온디맨드) + SQLite 캐시 + 다음 N개 프리페치

## 0) 준비
Node.js 18+ (추천 20)

## 1) 자막 파일
`subtitles.csv` (KR/EN만)
```csv
cue_id,kr,en
1,"한국어...","English..."
2,"...","..."
```

## 2) 실행
```bash
npm install
npm start
```

접속:
- 오퍼레이터: http://localhost:3000/operator.html
- 무대 스크린: http://localhost:3000/stage.html
- 관객 모바일: http://<노트북IP>:3000/mobile.html

## 3) 번역 API 설정
환경변수로 선택:
- TRANSLATE_PROVIDER=deepl | google | openai | mock

### (A) DeepL (추천: 독일어 품질 좋음)
- 키 발급 후:
```bash
export TRANSLATE_PROVIDER=deepl
export DEEPL_AUTH_KEY="여기에키"
# free 키면 api-free.deepl.com, pro 키면 api.deepl.com 자동감지
```

### (B) Google Cloud Translation (언어 폭 넓음)
```bash
export TRANSLATE_PROVIDER=google
export GOOGLE_TRANSLATE_API_KEY="여기에키"
```

### (C) OpenAI (토큰 과금, 모델 선택 가능)
```bash
export TRANSLATE_PROVIDER=openai
export OPENAI_API_KEY="여기에키"
export OPENAI_MODEL="gpt-4o-mini"
```

### (D) 테스트용(가짜 번역)
```bash
export TRANSLATE_PROVIDER=mock
```

## 4) 공연 운영 팁
- 극장 Wi‑Fi를 쓸 경우, 리허설 때 “휴대폰 → 노트북 서버 접속”이 되는지 꼭 테스트하세요.
- 모바일 페이지는 Start 버튼을 눌러 Wake Lock을 켠 뒤 사용하세요(가능한 기기에서 화면 꺼짐 방지).
