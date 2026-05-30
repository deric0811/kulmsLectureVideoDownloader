let capturedVideoUrl = null;

// 1. 영상 URL 포착 (ssmovie.mp4와 screen.mp4 모두 완벽하게 잡아냅니다)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.url.includes("ssmovie.mp4") || details.url.includes("screen.mp4")) {
      capturedVideoUrl = details.url;
      console.log("[LMS Helper] URL 포착 완료♡♡♡♡♡♡♡:", capturedVideoUrl);
      
      // 영상이 감지되면 아이콘에 초록색 GET 배지를 띄워 사용자에게 알림
      chrome.action.setBadgeText({ text: "GET" });
      chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
    }
  },
  { urls: ["*://korea-cms-object.cdn.gov-ntruss.com/*"] }
);

// 2. 팝업(popup.js)과의 통신을 담당하는 리스너
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "CHECK_STATUS") {
    // 팝업이 열릴 때 영상이 준비되었는지 응답
    sendResponse({ hasVideo: !!capturedVideoUrl });
    return true; 
  }
  
  if (message.action === "START_DOWNLOAD") {
    // 팝업에서 다운로드 버튼을 누르면 다운로드 코어 로직 실행
    executeDownload(message.tabId);
  }
});

// 3. 실제 네이티브 다운로드를 처리하는 코어 함수
async function executeDownload(tabId) {
  if (!capturedVideoUrl) return;
  console.log("[LMS Helper] 강의명 추출 및 네이티브 다운로드 시도...");
  
  try {
    // A. 현재 탭에서 강의명 추출
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => document.title || "LMS_Lecture"
    });

    // B. 파일명에 쓸 수 없는 특수문자 제거
    const rawTitle = injectionResults[0].result;
    const safeTitle = rawTitle.replace(/[\/\\?%*:|"<>]/g, '_').trim() || "LMS_Lecture";
    console.log("[LMS Helper] 최종 파일명:", safeTitle);

    // C. DNR 동적 룰 업데이트 (Referer 주입 + 추출한 강의명으로 파일명 강제 지정)
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1], 
      addRules: [{
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: "https://kucom.korea.ac.kr/" }
          ],
          responseHeaders: [
            { header: "Content-Disposition", operation: "set", value: `attachment; filename="${safeTitle}.mp4"` }
          ]
        },
        condition: { 
          urlFilter: "*lms_dl=1*", 
          resourceTypes: ["sub_frame", "main_frame", "other"] 
        }
      }]
    });

    // D. 식별자 쿼리 파라미터 생성
    const separator = capturedVideoUrl.includes('?') ? '&' : '?';
    const triggerUrl = capturedVideoUrl + separator + "lms_dl=1";

    // E. 탭에 투명 iframe 주입하여 브라우저 네이티브 다운로드(RAM 점유율 0%) 트리거
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: (dlUrl) => {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = dlUrl;
        document.body.appendChild(iframe);
        
        // 다운로드가 브라우저에 인계되면 iframe은 DOM에서 삭제
        setTimeout(() => iframe.remove(), 5000);
      },
      args: [triggerUrl]
    });

    // F. 상태 초기화
    chrome.action.setBadgeText({ text: "OK" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
    capturedVideoUrl = null;

  } catch (error) {
    console.error("[LMS Helper] 처리 중 에러 발생:", error);
    chrome.action.setBadgeText({ text: "ERR" });
    chrome.action.setBadgeBackgroundColor({ color: "#F44336" });
  }
}