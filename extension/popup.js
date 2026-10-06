// 팝업 로직: 서버 상태/제어(포트+프로그램명) + navigator 위장 토글.

const $ = (id) => document.getElementById(id);
let currentOrigin = null;
let pendingErr = ""; // start/stop 이 돌려준 오류. 다음 조작 전까지 유지한다.

// 포트 → 프로그램명 (host/config.js 와 일치)
const PORTS = [
  [19006, "MagicLine4NX"],
  [21300, "IPinside LWS Agent"],
  [21400, "IPinside v6 engine (wss)"],
  [10531, "AnySign4PC (wss)"],
  [16105, "Veraport"],
  [16106, "Veraport"],
  [12380, "AhnLab Safe Transaction"],
  [15530, "AhnLab Safe Transaction"],
  [55920, "AhnLab ASTX2"],
  [55921, "AhnLab ASTX2"],
  [55922, "AhnLab ASTX2"],
  [55923, "AhnLab ASTX2"],
  [55924, "AhnLab ASTX2"],
  [55925, "AhnLab ASTX2"],
  [55926, "AhnLab ASTX2"],
  [55927, "AhnLab ASTX2"],
  [55928, "AhnLab ASTX2"],
  [55929, "AhnLab ASTX2"],
  [7710, "INISAFE CrossWeb EX"],
  [7711, "INISAFE CrossWeb EX"],
  [4441, "INISAFE CrossWeb EX (portScan)"],
  [4442, "INISAFE CrossWeb EX (portScan)"],
  [4443, "INISAFE CrossWeb EX (portScan)"],
  [4444, "INISAFE CrossWeb EX (portScan)"],
  [4445, "INISAFE CrossWeb EX (portScan)"],
  [16100, "nProtect Online Security"],
  [14440, "nProtect NOS (keyboard)"],
  [14441, "nProtect NOS (keyboard)"],
  [14442, "nProtect NOS (keyboard)"],
  [14443, "nProtect NOS (keyboard)"],
  [34580, "TouchEn nxKey (WS)"],
  [34581, "TouchEn nxKey crossEX (wss)"],
  [34582, "TouchEn nxKey crossEX (wss)"],
  [34583, "TouchEn nxKey crossEX (wss)"],
];

function host(cmd, extra) {
  chrome.runtime.sendMessage({ to: "host", msg: Object.assign({ cmd }, extra || {}) });
}

// 포트 행 초기 렌더 (모두 닫힘)
function renderPortRows() {
  const tb = $("portRows");
  tb.innerHTML = "";
  for (const [port, name] of PORTS) {
    const tr = document.createElement("tr");
    tr.id = "pr-" + port;
    tr.innerHTML =
      '<td style="width:14px"><span class="dot" id="pd-' + port + '"></span></td>' +
      '<td class="pt">' + port + "</td>" +
      '<td class="nm">' + name + "</td>";
    tb.appendChild(tr);
  }
}

const BUSY_HINT = "이전 서버가 남아 있거나 실제 보안 프로그램이 같은 포트를 쓰는 중";

// 열려 있는데 우리 서버가 관리하는 게 아니면 그 행만 빨갛게 깜빡이고 툴팁을 단다.
function setServer(running, ports) {
  $("srvDot").className = "dot " + (running ? "on" : "off");
  $("srvText").textContent = running ? "서버 실행 중" : "서버 중지됨";
  for (const [port] of PORTS) {
    const d = $("pd-" + port);
    const tr = $("pr-" + port);
    if (!d || !tr) continue;
    const open = !!(ports && ports[port]);
    const bad = open && !running;
    d.className = "dot " + (bad ? "bad" : open && running ? "on" : "");
    tr.classList.toggle("badrow", bad);
    if (bad) tr.title = BUSY_HINT;
    else tr.removeAttribute("title");
  }
}

// 호스트/백그라운드 → 팝업 수신
chrome.runtime.onMessage.addListener((m) => {
  if (m.from !== "host") return;
  if (m.disconnected || m.error) {
    $("srvErr").textContent = m.error
      ? "호스트 연결 실패: " + m.error + " (설치 스크립트 실행 필요 — Windows: install.ps1 / macOS·Linux: install.sh)"
      : "호스트 연결 끊김";
    setServer(false, null);
    return;
  }
  const msg = m.msg;
  if (!msg) return;
  if (msg.cmd === "status") {
    // 포트 점유는 배너 대신 해당 포트 행으로 보여준다(setServer). 배너는 그 외 오류만.
    $("srvErr").textContent = pendingErr;
    setServer(msg.running, msg.ports);
  } else if (msg.cmd === "start" || msg.cmd === "stop") {
    // busyPort 오류는 행 표시로 충분하니 배너를 띄우지 않는다.
    pendingErr = msg.ok === false && msg.error && !msg.busyPort ? msg.error : "";
    $("srvErr").textContent = pendingErr;
    setTimeout(() => host("status"), 500);
  }
});

$("btnStart").onclick = () => { pendingErr = ""; $("srvErr").textContent = ""; host("start"); };
$("btnStop").onclick = () => { pendingErr = ""; $("srvErr").textContent = ""; host("stop"); };
$("btnLog").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("log.html") });

// navigator 위장 (기본 끄기. 현재 사이트에만 적용)
const spoofRadios = () => document.querySelectorAll('input[name="spoof"]');

function setSpoofMode(mode) {
  for (const r of spoofRadios()) r.checked = (r.value === (mode || "off"));
}
function disableSpoof() {
  for (const r of spoofRadios()) r.disabled = true;
}
function enableSpoof() {
  for (const r of spoofRadios()) r.disabled = false;
}

for (const r of spoofRadios()) {
  r.onchange = async () => {
    if (!currentOrigin || !r.checked) return;
    const requestedMode = r.value;
    $("spoofErr").textContent = "";
    disableSpoof();
    try {
      const result = await chrome.runtime.sendMessage({
        action: "spoofSetSite",
        origin: currentOrigin,
        mode: requestedMode,
      });
      const modes = await chrome.runtime.sendMessage({ action: "spoofGetModes" });
      const savedMode = modes && modes[currentOrigin] || "off";
      setSpoofMode(savedMode);
      if (!result || !result.ok) {
        throw new Error(result && result.error || "백그라운드 응답이 없습니다.");
      }
      if (savedMode !== requestedMode) {
        throw new Error("설정 저장을 확인하지 못했습니다.");
      }
    } catch (e) {
      $("spoofErr").textContent = "위장 설정 오류: " + e.message;
    } finally {
      enableSpoof();
    }
  };
}

async function init() {
  renderPortRows();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https?:/.test(tab.url)) {
      currentOrigin = new URL(tab.url).origin;
      $("spoofOrigin").textContent = new URL(tab.url).host;
      const modes = await chrome.runtime.sendMessage({ action: "spoofGetModes" });
      setSpoofMode(modes && modes[currentOrigin]);
    } else {
      $("spoofOrigin").textContent = "(웹페이지 아님)";
      disableSpoof();
    }
  } catch (e) {
    $("spoofErr").textContent = "위장 상태 확인 오류: " + e.message;
    disableSpoof();
  }
  host("status");
}

init();
