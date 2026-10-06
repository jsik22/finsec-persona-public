// MAIN world, document_start 로 등록됨(background 의 registerContentScripts).
// content-platform.js 의 반대 방향 — 페이지 스크립트가 navigator 를 읽기 전에 macOS 로 위조한다.
//
// 왜 필요한가: 일부 사이트는 Windows 일 때 오히려 더 까다로운 경로를 탄다.
// 신한은행 로그인(menuCode 252400000000)이 그 예로, shbComm.js 가
//   platformInfo.name = navigator.platform → /Win32/i 면 platformInfo.Windows = true
//   if (platformInfo.Windows && ...) TOUCHENEX_CHECK.check(...)   // 키보드보안 검사 대기
//   else                             shbComm.doComBizPageStart()  // 그냥 통과
// 로 갈린다. 키보드보안(TouchEn nxKey)은 Windows 전용이라 mock 으로 완주시킬 수 없어
// 진짜 Windows 에서는 "준비중" 오버레이가 영영 안 걷힌다. MacIntel 로 보이면 else 로 빠진다.
(function () {
  function def(obj, prop, val) {
    try { Object.defineProperty(obj, prop, { get: function () { return val; }, configurable: true }); } catch (e) {}
  }
  // 실제 Chrome 버전을 유지하되 OS 만 macOS 로
  var chromeVer = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || "148.0.0.0";
  var macTail = "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chromeVer + " Safari/537.36";

  def(navigator, "platform", "MacIntel");
  def(navigator, "userAgent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " + macTail);
  def(navigator, "appVersion", "5.0 (Macintosh; Intel Mac OS X 10_15_7) " + macTail);
  def(navigator, "oscpu", "Intel Mac OS X 10.15");

  // Chromium userAgentData (있으면)
  try {
    if (navigator.userAgentData) def(navigator.userAgentData, "platform", "macOS");
  } catch (e) {}

  try { console.log("[finsec] navigator → macOS(MacIntel) 위장 적용"); } catch (e) {}
})();
