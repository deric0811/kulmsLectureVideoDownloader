document.addEventListener('DOMContentLoaded', async () => {
  const statusBox = document.getElementById('statusBox');
  const downloadBtn = document.getElementById('downloadBtn');

  // 현재 열려있는 탭 정보 가져오기
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // 1. 백그라운드에 비디오/XML 포착 여부 물어보기 (하나라도 있으면 활성화)
  chrome.runtime.sendMessage({ action: "CHECK_STATUS" }, (response) => {
    if (response && response.hasMedia) {
      statusBox.innerHTML =
        "<b>강의가 감지되었습니다.</b><br>" +
        "클릭 시 전체 파트가 순차 다운로드됩니다.";
      downloadBtn.style.display = "block";
    } else {
      statusBox.innerHTML =
        "<b>포착된 영상이 없습니다!!</b><br>LMS에서 영상을 먼저 재생해 주세여.";
    }
  });

  // 2. 다운로드 버튼 클릭 시 백그라운드로 실행 명령 전송
  downloadBtn.addEventListener('click', () => {
    downloadBtn.innerText = "처리 중...";
    downloadBtn.disabled = true;

    chrome.runtime.sendMessage({ action: "START_DOWNLOAD", tabId: tab.id });

    // 명령 전송 후 1초 뒤에 팝업창을 깔끔하게 닫아줌
    setTimeout(() => window.close(), 1000);
  });
});