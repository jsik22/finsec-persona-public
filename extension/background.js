// MV3 service worker.
//  ① Native Messaging 으로 Node 호스트(=mock 서버) 제어 (start/stop/status/log)
//  ② 사이트별 navigator 위장 content script 동적 등록 (registerContentScripts, world:MAIN)

const HOST_NAME = "com.finsec.host";
let port = null;

function connect() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    broadcast({ from: "host", error: "connectNative 실패: " + e.message });
    return null;
  }
  port.onMessage.addListener((msg) => broadcast({ from: "host", msg }));
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
    port = null;
    broadcast({ from: "host", disconnected: true, error: err || null });
  });
  return port;
}

function hostSend(obj) {
  const p = connect();
  if (!p) return;
  try { p.postMessage(obj); } catch (e) {
    port = null;
    broadcast({ from: "host", error: "postMessage 실패: " + e.message });
  }
}

// 팝업으로 브로드캐스트 (팝업이 닫혀있으면 무시)
function broadcast(obj) {
  chrome.runtime.sendMessage(obj).catch(() => {});
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.to === "host") {
    hostSend(req.msg);
    return;
  }
  if (req.action === "spoofGetModes") {
    getModes().then((o) => sendResponse(o));
    return true;
  }
  if (req.action === "spoofSetSite") {
    enqueueSpoof(() => setSite(req.origin, req.mode))
      .then((mode) => sendResponse({ ok: true, mode }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// ---- navigator 위장: 기본 OFF, 사이트별 모드 ----
//   "win" → Win32 위장.    맥·리눅스가 Windows 전용 모듈 때문에 막히는 사이트용.
//   "mac" → MacIntel 위장. Windows 일 때 오히려 키보드보안 등을 강제하는 사이트용(예: 신한은행).
// 두 방향이 공존해야 해서 on/off 가 아니라 모드로 둔다.
const SPOOF_JS = { win: "content-platform.js", mac: "content-platform-mac.js" };
let spoofQueue = Promise.resolve();

// 팝업을 빠르게 여러 번 눌러도 read-modify-write 가 서로 덮어쓰지 않게 직렬화한다.
function enqueueSpoof(task) {
  const next = spoofQueue.then(task);
  spoofQueue = next.catch(() => {});
  return next;
}

function idFor(origin) {
  return "spoof-" + origin.replace(/[^a-z0-9]/gi, "_");
}

// { origin: "win" | "mac" }
async function getModes() {
  const r = await chrome.storage.local.get(["siteModes", "enabledOrigins"]);
  if (r.siteModes) return { ...r.siteModes };
  // 구버전 마이그레이션: enabledOrigins 는 켜진 사이트 배열이었고 전부 Win32 위장이었다.
  const modes = {};
  if (Array.isArray(r.enabledOrigins)) for (const o of r.enabledOrigins) modes[o] = "win";
  await chrome.storage.local.set({ siteModes: modes });
  await chrome.storage.local.remove("enabledOrigins");
  return modes;
}

function spoofDefinition(origin, mode) {
  return {
    id: idFor(origin),
    matches: [origin + "/*"],
    js: [SPOOF_JS[mode]],
    runAt: "document_start",
    world: "MAIN",
    allFrames: true,
    persistAcrossSessions: true,
  };
}

function registerSpoof(origin, mode) {
  return chrome.scripting.registerContentScripts([spoofDefinition(origin, mode)]);
}

async function applySpoof(origin, mode) {
  const id = idFor(origin);
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });

  if (!SPOOF_JS[mode]) {
    if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
    return;
  }

  if (!registered.length) {
    await registerSpoof(origin, mode);
    return;
  }

  // 이미 등록된 ID를 unregister/register 하는 사이의 공백과 duplicate-ID 오류를 피한다.
  try {
    await chrome.scripting.updateContentScripts([spoofDefinition(origin, mode)]);
  } catch (e) {
    // 구형 Chromium에서 updateContentScripts 제약이 있으면 안전하게 교체한다.
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
    await registerSpoof(origin, mode);
  }
}

// mode 가 "win"/"mac" 이면 그 스크립트로 교체 등록, 그 외("off" 등)는 해제
async function setSite(origin, mode) {
  const url = new URL(origin);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) {
    throw new Error("올바르지 않은 사이트 주소: " + origin);
  }
  if (mode !== "off" && !SPOOF_JS[mode]) {
    throw new Error("지원하지 않는 위장 모드: " + mode);
  }

  const modes = await getModes();
  if (SPOOF_JS[mode]) {
    modes[origin] = mode;
  } else {
    delete modes[origin];
  }

  // 등록 API가 일시적으로 실패해도 사용자의 선택은 잃지 않도록 먼저 저장한다.
  await chrome.storage.local.set({ siteModes: modes });
  await applySpoof(origin, mode);
  return mode;
}

// 재기동 시: 모든 동적 등록 정리 후 allowlist 만 재등록 (기본 OFF 보장)
chrome.runtime.onStartup.addListener(() => enqueueSpoof(reregisterAll));
chrome.runtime.onInstalled.addListener(() => enqueueSpoof(reregisterAll));
async function reregisterAll() {
  const modes = await getModes();
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const spoofIds = registered.map((s) => s.id).filter((id) => id.startsWith("spoof-"));
  if (spoofIds.length) await chrome.scripting.unregisterContentScripts({ ids: spoofIds });
  for (const origin of Object.keys(modes)) {
    if (!SPOOF_JS[modes[origin]]) continue;
    try {
      await registerSpoof(origin, modes[origin]);
    } catch (e) {
      console.error("[finsec] navigator 위장 재등록 실패", origin, e);
    }
  }
}
