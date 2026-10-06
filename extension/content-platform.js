// MAIN world, document_start 로 등록됨(background 의 registerContentScripts).
// 페이지 스크립트가 navigator 를 읽기 전에 platform/userAgent 를 Windows 로 위조한다.
// Wizvera veraport20.js 등은 navigator.platform("MacIntel") 으로 OS 를 판정하므로 이게 핵심.
(function () {
  function def(obj, prop, val) {
    try { Object.defineProperty(obj, prop, { get: function () { return val; }, configurable: true }); } catch (e) {}
  }
  // 실제 Chrome 버전을 유지하되 OS 만 Windows 로
  var chromeVer = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || "148.0.0.0";
  var winUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chromeVer + " Safari/537.36";

  def(navigator, "platform", "Win32");
  def(navigator, "userAgent", winUA);
  def(navigator, "appVersion", "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chromeVer + " Safari/537.36");
  def(navigator, "oscpu", "Windows NT 10.0; Win64; x64");

  // Chromium userAgentData (있으면)
  try {
    if (navigator.userAgentData) def(navigator.userAgentData, "platform", "Windows");
  } catch (e) {}

  try { console.log("[finsec] navigator → Windows(Win32) 위장 적용"); } catch (e) {}
})();
