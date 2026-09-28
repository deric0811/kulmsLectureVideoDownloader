// ============================================================================
// KULMS Video Downloader — background.js (MV3 Service Worker)
// 버전 1.4.0 — cURL 역분석 기반 인증 파이프라인 완성
//
//   [결정적 사실] Chrome MV3 스펙상 Service Worker의 fetch·chrome.downloads
//   요청은 initiator 권한 제약으로 DNR modifyHeaders(Referer/CORS 주입)가
//   적용되지 않는다.
//     - SW fetch(chapter.xml)  → Referer 누락 → 1704B 에러 HTML(200 OK) 수신
//     - chrome.downloads.download → Referer 누락 → Failed - Forbidden
//   따라서 아래 원래 성공 모델로 복귀한다:
//     - chapter.xml 파싱: LMS 탭(동일 출처) fetch + 세션 쿠키 인증
//       (cURL 확정: https://kucom.korea.ac.kr/.../contents/web_files/chapter.xml)
//     - 다운로드 실행  : 탭 내 투명 iframe 순차 주입 + DNR Content-Disposition(Rule 1)
// ============================================================================

// ----------------------------------------------------------------------------
// 0. 전역 상태 및 상수
//    * capturedXmlUrl   : chapter.xml (강의 전체 챕터 구조) URL — 최우선 감지
//    * capturedVideoUrl : 단일 영상 fallback URL (ssmovie.mp4 / screen.mp4 / main_)
// ----------------------------------------------------------------------------
let capturedXmlUrl = null;
let capturedVideoUrl = null;

const SINGLE_RULE_ID = 1;          // 단일 영상 fallback용 다운로드 룰 ID
const KUCOM_CORS_RULE_ID = 2;      // [보조] kucom chapter.xml CORS 우회 룰 ID
const PART_RULE_ID_BASE = 100;     // Rule 1 계열: 파트별 다운로드 룰 시작 ID
const REFERER_VALUE = "https://kucom.korea.ac.kr/";
const IFRAME_INTERVAL_MS = 1000;   // iframe 주입 간격 (제스처 소진/Silent Drop 회피)
const IFRAME_LIFETIME_MS = 5000;   // iframe DOM 잔존 수명 (주입 후 자동 제거)
const BADGE_RESET_MS = 3000;       // 완료 배지 표시 후 초기화 시간

// 배지 설정 헬퍼
function setBadge(text, color) {
  chrome.action.setBadgeText({ text: text });
  if (color) chrome.action.setBadgeBackgroundColor({ color: color });
}

// 포착된 비디오 URL에서 LMS 본진 서버의 chapter.xml 절대 경로를 역산(Derive)한다.
// cURL 확정 데이터:
//   플레이어 실제 호출:
//     https://kucom.korea.ac.kr/contents7/kruniv1001/6ab13ac733ea5/contents/web_files/chapter.xml?_=ts
//   → 비디오 URL 경로에서 "(/contents\d*/.../contents/)" 구간을 뜯어내고
//     도메인을 https://kucom.korea.ac.kr 로 치환한 뒤 "web_files/chapter.xml" 을 결합.
function deriveTargetXmlUrl(videoUrl) {
  if (!videoUrl) return null;
  const match = videoUrl.match(/(\/contents\d*\/[^\/]+\/[^\/]+\/contents\/)/i);
  if (match) {
    return "https://kucom.korea.ac.kr" + match[1] + "web_files/chapter.xml";
  }
  return null;
}

// ----------------------------------------------------------------------------
// 0-2. [보조] kucom chapter.xml CORS 우회 룰 확보
//   최상위 프레임(kulms)에서 kucom 서브도메인을 fetch 하는 Cross-Origin
//   "Failed to fetch" 대비: chapter.xml 응답에 ACAO:* + ACAC:true 를 주입한다.
//   (동일 출처 kucom 프레임을 발견해 그 안에서 실행되면 이 룰은 쓰이지 않는다)
// ----------------------------------------------------------------------------
async function ensureKucomCorsRule() {
  let currentRules = [];
  try {
    currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  } catch (e) {
    currentRules = [];
  }

  // 기존 id 2 를 정리하고 재등록 (중복 ID 방지)
  const removeRuleIds = currentRules
    .filter((r) => r.id === KUCOM_CORS_RULE_ID)
    .map((r) => r.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeRuleIds,
    addRules: [
      {
        id: KUCOM_CORS_RULE_ID,
        priority: 3,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
            { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
          ]
        },
        condition: {
          urlFilter: "*kucom.korea.ac.kr*chapter.xml*",
          resourceTypes: ["xmlhttprequest"]
        }
      }
    ]
  });
  console.log("[LMS Helper] kucom CORS 우회 룰 확보 (id:", KUCOM_CORS_RULE_ID + ")");
}

// ----------------------------------------------------------------------------
// 0-4. DNR Rule 1 계열 (파트별 다운로드 강제화) 원자적 등록
//   IFrame(sub_frame) 요청에 Referer + Content-Disposition: attachment 를 주입한다.
//   파트별 고유 토큰(lms_dl=p01..pNN)으로 룰을 분리하여
//   각 파트가 자기 파일명을 받도록 한다. (동일 폭 제로패딩 → substring 충돌 방지)
// ----------------------------------------------------------------------------
async function clearAndSetPartRules(targets) {
  // [ID 충돌 해결] "Rule with id 100 does not have a unique ID" 방지!
  //   현재 dynamicRules 를 전부 조회해 removeRuleIds: 전체 로 깨끗이 비운 뒤
  //   고유 ID(100 + index / 1) 로만 재등록한다.
  //   (crash/재실행으로 등록 기록이 소실돼도 중복 ID 가 남지 않음)
  let currentRules = [];
  try {
    currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  } catch (e) {
    currentRules = [];
  }
  const removeRuleIds = currentRules.map((r) => r.id);

  const addRules = targets.map((t) => ({
    id: t.ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Referer", operation: "set", value: REFERER_VALUE }
      ],
      responseHeaders: [
        {
          header: "Content-Disposition",
          operation: "set",
          value: 'attachment; filename="' + t.fileName + '"'
        }
      ]
    },
    condition: {
      urlFilter: "*" + t.ruleToken + "*",
      resourceTypes: ["sub_frame"]
    }
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeRuleIds,
    addRules: addRules
  });
  console.log("[LMS Helper] 파트별 다운로드 룰 원자적 등록 완료 — 룰 수:", addRules.length);
}

// ----------------------------------------------------------------------------
// 1. 네트워크 관찰 (webRequest)
//    - chapter.xml 요청을 최우선으로 포착하여 멀티 챕터 구조를 파악한다.
//      (cURL 확정: kucom.korea.ac.kr 과 gov-ntruss CDN 양쪽 모두 관찰 필요)
//    - ssmovie.mp4 / screen.mp4 / main_ 단일 영상은 XML 미발견 시 fallback으로 유지.
//    - 우리 자신이 주입한 iframe 다운로드 요청(lms_dl= 포함)은 상태 오염 방지를 위해 스킵.
// ----------------------------------------------------------------------------
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // [가드] 우리가 유발한 iframe 다운로드 트래픽은 재포착하지 않는다
    if (details.url.includes("lms_dl=")) return;

    // [우선순위 1] chapter.xml — 다중 분할 강의 전체 구조
    if (details.url.includes("chapter.xml")) {
      capturedXmlUrl = details.url;
      console.log("[LMS Helper] chapter.xml 포착 (멀티 챕터 구조):", capturedXmlUrl);
      setBadge("GET", "#4CAF50");
      return;
    }

    // [우선순위 2] 단일 영상 fallback — XML이 미감지된 구형/단일 강의용
    const isMp4 = details.url.toLowerCase().endsWith(".mp4");
    if (
      isMp4 &&
      (details.url.includes("ssmovie.mp4") ||
        details.url.includes("screen.mp4") ||
        details.url.includes("main_"))
    ) {
      capturedVideoUrl = details.url;
      console.log("[LMS Helper] 단일 영상 URL 포착 (fallback):", capturedVideoUrl);
      setBadge("GET", "#4CAF50");
    }
  },
  { urls: ["*://*.gov-ntruss.com/*", "*://*.korea.ac.kr/*"] }
);

// ----------------------------------------------------------------------------
// 1-2. 플레이어 실제 요청 헤더 스니퍼 (디버깅용)
//   플레이어가 chapter.xml을 정상 호출할 때 보내는 진짜 Referer를 확인한다.
//   (requestHeaders는 [{name, value}, ...] 배열 형태 → find()로 탐색)
// ----------------------------------------------------------------------------
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.url.includes("chapter.xml") && !details.url.includes("lms_dl=")) {
      // requestHeaders는 [{name, value}, ...] 배열 형태 — find()로 정상 탐색
      const headersList = details.requestHeaders || [];
      const ref =
        headersList.find((h) => h.name.toLowerCase() === "referer")?.value ||
        "(없음)";
      const orig =
        headersList.find((h) => h.name.toLowerCase() === "origin")?.value ||
        "(없음)";
      console.log(
        "[LMS Helper] 📡 chapter.xml 요청 헤더 — Referer: [" + ref +
          "] | Origin: [" + orig + "]"
      );
    }
  },
  { urls: ["*://*.gov-ntruss.com/*", "*://*.korea.ac.kr/*"] },
  ["requestHeaders", "extraHeaders"]
);

// ----------------------------------------------------------------------------
// 2. 팝업(popup.js)과의 통신 리스너
//    - CHECK_STATUS  : XML 또는 단일 영상 중 하나라도 포착되면 준비 완료로 응답
//    - START_DOWNLOAD: 다운로드 파이프라인 실행
// ----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "CHECK_STATUS") {
    sendResponse({
      hasXml: !!capturedXmlUrl,
      hasVideo: !!capturedVideoUrl,
      hasMedia: !!(capturedXmlUrl || capturedVideoUrl),
      mode: capturedXmlUrl ? "xml" : capturedVideoUrl ? "single" : "none"
    });
    return true;
  }

  if (message.action === "START_DOWNLOAD") {
    executeMultiDownload(message.tabId);
  }
});

// ============================================================================
// 3. 다운로드 코어 파이프라인 (iframe 아키텍처)
//    A. kucom 동일 출처 프레임/탭에서 chapter.xml fetch + 파싱 (SW 직접 fetch 금지)
//    B. 파트별 URL/파일명/토큰 타깃 구축 (URL 인덱스 배열)
//    C. DNR 룰 원자적 등록 (clearAndSetPartRules — ID 충돌 방지)
//    D. 탭 내 투명 iframe을 1000ms 간격으로 순차 주입 → 네이티브 다운로드
//    E. 완료 배지 및 상태 정리
// ============================================================================
async function executeMultiDownload(tabId) {
  if (!capturedXmlUrl && !capturedVideoUrl) return;

  try {
    // MV3 Service Worker 수면(Idle Timeout)으로 capturedXmlUrl이 소실되었더라도,
    // 포착된 단일 영상 URL의 "/contents/" 경로에서 chapter.xml 경로를 역산한다.
    const targetXmlUrl = capturedXmlUrl || deriveTargetXmlUrl(capturedVideoUrl);
    console.log(
      "[LMS Helper] 다운로드 시작 —",
      targetXmlUrl ? "멀티 챕터 chapter.xml 파싱 시도" : "단일 영상 fallback"
    );

    // ---- A. chapter.xml 파싱: kucom 동일 출처 프레임 우선 실행 -----------
    //   [CORS 근본 해결] 최상위 탭은 kulms.korea.ac.kr, targetXmlUrl 은
    //   kucom.korea.ac.kr 로 서로 다른 서브도메인 → 최상위 프레임 fetch 는
    //   Cross-Origin "Failed to fetch" 가 발생한다.
    //   → chrome.webNavigation.getAllFrames 로 kucom.korea.ac.kr 서브프레임의
    //     frameId 를 찾아 그 내부에서 실행 (동일 출처 → 세션 쿠키 자동 동반).
    //     frameId 미발견 시 최상위 프레임 실행 + DNR CORS 룰(id 2)로 보조.
    await ensureKucomCorsRule();

    // 강의명은 최상위 프레임(예: kulms.korea.ac.kr)에서 추출
    const [topTitleResult] = await chrome.scripting.executeScript({
      target: { tabId: tabId, frameIds: [0] },
      func: () => document.title || "LMS_Lecture"
    });
    const topTitle = (topTitleResult && topTitleResult.result) || "LMS_Lecture";

    // kucom.korea.ac.kr 서브프레임 탐색 (없으면 최상위 프레임으로 폴백)
    let parseTarget = { frameIds: [0] };
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tabId });
      const kucomFrame = frames.find(
        (f) => f.url && f.url.includes("kucom.korea.ac.kr")
      );
      if (kucomFrame) {
        parseTarget = { frameIds: [kucomFrame.frameId] };
        console.log(
          "[LMS Helper] kucom 동일 출처 프레임 발견 — frameId:",
          kucomFrame.frameId
        );
      }
    } catch (e) {
      console.error(
        "[LMS Helper] getAllFrames 실패(webNavigation 권한 부재) → 최상위 프레임 사용:",
        e
      );
    }

    const [parseResult] = await chrome.scripting.executeScript({
      target: { tabId: tabId, ...parseTarget },
      func: async (xmlUrl, fallbackVideoUrl) => {
        const title = document.title || "LMS_Lecture";
        const fallbackUrls = fallbackVideoUrl ? [fallbackVideoUrl] : [];

        // XML 자체가 없으면 즉시 fallback 결과 반환
        if (!xmlUrl) {
          return {
            success: false,
            reason: "xml_url_missing",
            safeTitle: title,
            urls: fallbackUrls,
            isMulti: false
          };
        }

        try {
          // [핵심] 동일 출처(kucom.korea.ac.kr) 호출 — 세션 쿠키 인증 필수
          //   CORS/Referer 강제 헤더 불필요 (동일 출처) → credentials: "include"
          //   플레이어와 동일한 XHR 헤더를 재현해 서버가 XML을 정상 서빙하도록 한다.
          const res = await fetch(xmlUrl, {
            credentials: "include",
            headers: {
              "Accept": "application/xml, text/xml, */*; q=0.01",
              "X-Requested-With": "XMLHttpRequest"
            }
          });
          const xmlText = await res.text();

          // 정규식으로 story_idref 전부 추출
          //   공백/따옴표 변형에 안전하도록 \s* 와 ['"] 양쪽 매칭
          const matches = [...xmlText.matchAll(/story_idref\s*=\s*["']([^"']+)["']/g)];
          const storyIds = matches.map((m) => m[1]);

          // 디버깅용: 수신 본문 미리보기(0~150자)를 SW로 반환
          const preview = xmlText.slice(0, 150);

          // HTML 에러 본문일 경우 제목/내용 요약으로 즉시 원인 판별
          const htmlTitle = xmlText.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "";
          // <style>/<script> 블록을 먼저 제거해 실제 에러 텍스트만 남긴다
          const textSnippet = xmlText
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 100);

          // 비디오 파일 Base URL(CDN 경로 .../contents/) 을 포착 영상 URL에서 유도
          //   예: https://...gov-ntruss.com/contents7/kruniv1001/6ab13ac733ea5/contents/…
          let mediaBase = "";
          if (fallbackVideoUrl) {
            const vm = fallbackVideoUrl.match(/(\/contents\d*\/[^\/]+\/[^\/]+\/contents\/)/i);
            if (vm) {
              mediaBase = fallbackVideoUrl.substring(
                0,
                fallbackVideoUrl.indexOf(vm[1]) + vm[1].length
              );
            }
          }

          if (storyIds.length > 0 && mediaBase) {
            const urls = storyIds.map(
              (id) => mediaBase + "media_files/main_" + id + ".mp4"
            );
            return {
              success: true,
              reason: "ok",
              preview: preview,
              htmlTitle: htmlTitle,
              textSnippet: textSnippet,
              safeTitle: title,
              urls: urls,
              isMulti: storyIds.length >= 2
            };
          }

          // 실패 사유 판별: story_idref 없음 vs CDN Base 유도 실패
          const failReason = storyIds.length > 0
            ? "media_base_derivation_failed"
            : "story_idref_not_found";
          return {
            success: false,
            reason: failReason,
            preview: preview,
            htmlTitle: htmlTitle,
            textSnippet: textSnippet,
            safeTitle: title,
            urls: fallbackUrls,
            isMulti: false
          };
        } catch (err) {
          // 탭 내부 에러를 삼키지 않고 객체로 반환 → SW 콘솔에 명확히 출력
          return {
            success: false,
            reason: String(err && err.message ? err.message : err),
            safeTitle: title,
            urls: fallbackUrls,
            isMulti: false
          };
        }
      },
      args: [targetXmlUrl, capturedVideoUrl]
    });

    const parsedResult =
      (parseResult && parseResult.result) || {
        success: false,
        reason: "no_result",
        safeTitle: "LMS_Lecture",
        urls: []
      };

    // SW 콘솔 출력: 수신 본문 미리보기 + 성공/실패 구분 로그
    console.log("[LMS Helper] XML 수신 본문 미리보기:", parsedResult.preview);
    console.log(
      "[LMS Helper] 수신 응답 제목:",
      parsedResult.htmlTitle || "(N/A)",
      "| 내용 요약:",
      parsedResult.textSnippet || "(N/A)"
    );
    if (parsedResult.success) {
      console.log(
        "[LMS Helper] 🎉 chapter.xml 파싱 대성공! 총 " +
          parsedResult.urls.length + "개 파트 일괄 다운로드 시작"
      );
    } else {
      console.warn(
        "[LMS Helper] ⚠️ XML 파싱 실패 (" +
          (parsedResult.reason || "unknown") +
          "), 단일 영상으로 폴백"
      );
    }

    const safeTitle = String(topTitle || "LMS_Lecture")
      .replace(/[\/\\?%*:|"<>]/g, "_").trim() || "LMS_Lecture";
    const partUrls = parsedResult.urls || [];

    // ---- C. 타깃 결정 (URL + 파일명 + 고유 토큰) ----------------------
    //   토큰 제로패딩(고정 폭) 이유:
    //   urlFilter "*lms_dl=p1*"는 "lms_dl=p10"에도 매치되는 substring 문제 →
    //   동일 폭 코드(p01..pNN)로 룰 간 서로 substring이 되지 않게 한다.
    let targets;
    if (partUrls.length > 0) {
      const width = Math.max(2, String(partUrls.length).length);
      targets = partUrls.map((url, i) => {
        const fileName =
          partUrls.length === 1
            ? safeTitle + ".mp4"
            : safeTitle + "_Part" + (i + 1) + ".mp4";
        return {
          url: url,
          fileName: fileName,
          ruleToken: "lms_dl=p" + String(i + 1).padStart(width, "0"),
          ruleId: PART_RULE_ID_BASE + i
        };
      });
    } else if (capturedVideoUrl) {
      // 단일 영상 fallback (XML 실패·부재): 강의명.mp4
      targets = [{
        url: capturedVideoUrl,
        fileName: safeTitle + ".mp4",
        ruleToken: "lms_dl=1",
        ruleId: SINGLE_RULE_ID
      }];
    } else {
      return; // 유효한 다운로드 대상이 없는 경우
    }

    console.log("[LMS Helper] 최종 다운로드 타깃 수:", targets.length);
    targets.forEach((t, i) =>
      console.log("  [" + (i + 1) + "] " + t.fileName + " ← " + t.url)
    );

    // ---- C. DNR 룰 원자적 등록 (기존 룰 전체 정리 → 고유 ID 재등록) ------
    await clearAndSetPartRules(targets);

    // ---- E. 탭 내 투명 iframe 1000ms 간격 순차 주입 ---------------------
    //   chrome.downloads.download 폐기 (SW initiator는 DNR 미적용 → 403).
    //   iframe의 sub_frame 요청이 Rule 1에 매칭되어 attachment로 다운로드된다.
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const separator = t.url.includes("?") ? "&" : "?";
      const triggerUrl = t.url + separator + t.ruleToken;

      console.log(
        "[LMS Helper] [" + (i + 1) + "/" + targets.length + "] iframe 주입:",
        triggerUrl
      );

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: (dlUrl) => {
            const iframe = document.createElement("iframe");
            iframe.style.display = "none";
            iframe.src = dlUrl;
            document.body.appendChild(iframe);

            // 브라우저가 다운로드를 인계받으면 5초 뒤 DOM에서 제거 (메모리 정리)
            setTimeout(() => iframe.remove(), 5000);
          },
          args: [triggerUrl]
        });
      } catch (err) {
        console.error("[LMS Helper] " + (i + 1) + "번째 iframe 주입 실패:", err);
      }

      // 마지막 타깃이 아니면 1초 대기 후 다음 iframe 주입
      if (i < targets.length - 1) {
        await new Promise((r) => setTimeout(r, IFRAME_INTERVAL_MS));
      }
    }

    // ---- F. 완료 배지 및 상태 정리 -------------------------------------
    setBadge("OK", "#4CAF50");
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), BADGE_RESET_MS);
    capturedXmlUrl = null;
    capturedVideoUrl = null;
  } catch (error) {
    console.error("[LMS Helper] 처리 중 에러 발생:", error);
    setBadge("ERR", "#F44336");
  }
}