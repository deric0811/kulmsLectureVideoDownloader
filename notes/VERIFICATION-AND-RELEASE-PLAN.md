# KULMS Video Downloader — 검증 기록 및 배포 전 계획

작성 시점: 2026-10-03
기준 HEAD: `ae87c0982c14d70086c3182690b811d1ad92829f`
현재 소스 스냅샷: `backup/*.before-prerelease-planning-20261003-182958`
상태 기록: `backup/prerelease-snapshot-status-20261003-182958.txt`

> 이 문서는 **실제 사용자(브라우저) 검증**과 **문법 검사**, **아직 미구현 안전장치**를
> 구분한다. 기대 로그/설계는 실제 검증이 아니다.

---

## 1. 실제 사용자 검증 완료 (browser/runtime)

- 분할 강의 `6ab13ac733ea5`: Part 1~5 실제 다운로드 성공.
- 단일 강의 `6aafe9a3431ca`: 실제 다운로드, 배지/UI 성공.
- 단일 강의 `6a8ef2d9260d5`: 실제 다운로드, 배지/UI 성공.
- 같은 탭에서 서로 다른 과목으로 일반 페이지 이동 후 다운로드 성공.
- `6a8ef2d9260d5` 재진입/새로고침: generation 1→2, 재감지 및 다운로드 성공.
- 추가 유형 (둘 다 `screen.mp4` 단일 다운로드 성공):
  - 1) `chapter_list`/`chapter` XML은 있으나 `story_idref`가 없는 유형.
  - 2) chapter 요청이 오류 HTML인 유형.

## 2. 미검증 / 과장 금지 항목

- `6a8ef2895234d`: 중간 방문만 확인. 다운로드 성공 사례로 추가하지 않음.
- `6aafe9a3431ca`: `START → END` 뒤 두 번째 `START`가 관찰됨.
  in-flight 재사용은 동작했으나, “모든 경우 probe가 정확히 1회만 실행”은 미검증.
- 일반 A→B 전환 성공과 **늦은 A probe의 stale write 방지**는 별개다. 후자는 미검증.
- `story_idref` 없음은 XML 파싱 오류와 같은 의미가 아니다.
  (구조는 유효하나 파트 ID가 없는 상태로 분류해야 함)
- `mediaBaseFromUrl`의 모바일 경로 매칭: “모바일 전용 처리 없음”과
  “모바일 전부 매칭 실패”는 다르다. 실측 없음.
- 5개 파트 중 실제 존재가 확인된 것은 첫 파트뿐(제공 자료 기준).

## 3. 문법 검사 (동작 증명 아님)

```
node --check background.js   → OK
node --check popup.js        → OK
```
문법 통과는 런타임 동작/회귀 없음을 보장하지 않는다.

## 4. 아직 구현되지 않은 안전장치 (다음 패치 후보)

- 요청 전달됨/완료 표현 정리 및 지원 범위 안내
- 보류·실패 통지 (no_media / waiting_play / no_target / 예외)
- 전역 다운로드 인계 1작업 제한 (DNR dynamic rule이 전역이므로)
- 비활성 세션의 탭 뷰/배지 갱신 방지 (활성 소속 검사)

## 5. 후속 개선으로 이월 (이번에 구현하지 않음)

- probe 결과 캐싱
- 로그 중복 제거
- XML 상태 명칭 개선 (예: metadata_unavailable / chapter_list_empty)
