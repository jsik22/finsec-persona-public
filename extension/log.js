// 서버 로그 뷰어. background 를 통해 네이티브 호스트의 'log' 명령(server.log tail)을 받아 표시.

const logEl = document.getElementById("log");
const metaEl = document.getElementById("meta");
let autoTimer = null;

function requestLog() {
  chrome.runtime.sendMessage({ to: "host", msg: { cmd: "log", n: 1000 } });
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.from !== "host") return;
  if (m.error || m.disconnected) {
    logEl.textContent = "호스트 연결 실패: " + (m.error || "") + "\n(install.sh 실행 / 서버 [시작] 필요)";
    return;
  }
  if (m.msg && m.msg.cmd === "log") {
    const lines = m.msg.lines || [];
    const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
    logEl.textContent = lines.join("\n") || "(로그 없음 — 서버를 시작하거나 요청이 들어오면 기록됩니다)";
    metaEl.textContent = lines.length + "줄  ·  마지막 갱신 " + new Date().toLocaleTimeString();
    if (atBottom) logEl.scrollTop = logEl.scrollHeight; // 맨 아래 보던 중이면 따라가기
  }
});

document.getElementById("refresh").onclick = requestLog;
document.getElementById("auto").onchange = (e) => {
  if (e.target.checked) { autoTimer = setInterval(requestLog, 2000); }
  else { clearInterval(autoTimer); autoTimer = null; }
};

requestLog();
