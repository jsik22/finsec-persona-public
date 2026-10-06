"use strict";
// Native Messaging 호스트.
// 크롬 확장이 chrome.runtime.connectNative("com.finsec.host") 로 연결하면 크롬이 이 프로세스를
// 실행한다. stdin/stdout 으로 (4바이트 LE 길이 + UTF-8 JSON) 메시지를 주고받는다.
// 명령: start(서버 데몬 기동) / stop / status / ping.
// 서버는 server.js 를 detached 데몬으로 spawn 하고 pidfile 로 추적 → 확장/SW 가 죽어도 유지.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const net = require("net");
const config = require("./config");

const SERVER = path.join(__dirname, "server.js");
const PIDFILE = path.join(__dirname, "server.pid");
const LOG_FILE = path.join(__dirname, "server.log");
// 전 포트 확인 (HTTP/HTTPS 포트 + WebSocket + crossEX wss)
const ALL_PORTS = Object.keys(config.PORT_MAP).map(Number)
  .concat([config.WS_PORT], config.WSS_CROSSEX.ports, config.WSS_PROBE.map((p) => p.port))
  .sort((a, b) => a - b);

// ---- native messaging IO ----
function send(msg) {
  const buf = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([header, buf]));
}

let stash = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  stash = Buffer.concat([stash, chunk]);
  while (stash.length >= 4) {
    const len = stash.readUInt32LE(0);
    if (stash.length < 4 + len) break;
    let msg = null;
    try { msg = JSON.parse(stash.slice(4, 4 + len).toString("utf8")); } catch (e) {}
    stash = stash.slice(4 + len);
    if (msg) handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));

// ---- 데몬 제어 ----
function readPid() { try { return parseInt(fs.readFileSync(PIDFILE, "utf8"), 10) || 0; } catch (e) { return 0; } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return false; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 이미 열려 있는 첫 포트. pidfile 이 죽었는데 포트가 열려 있으면 다른 프로세스가 쥐고 있다는 뜻.
async function firstOpenPort() {
  for (const p of ALL_PORTS) if (await checkPort(p)) return p;
  return 0;
}

async function startServer() {
  const pid = readPid();
  if (pidAlive(pid)) return { ok: true, already: true, pid };
  // 포트가 이미 물려 있는데 spawn 하면 새 서버가 아무것도 못 잡고 즉시 죽는다.
  // 그 죽은 pid 가 pidfile 을 덮어써서 이후로 계속 "중지됨" 으로 보이게 된다.
  const busy = await firstOpenPort();
  if (busy) {
    // busyPort 를 따로 실어 보낸다. 팝업이 배너 대신 그 포트 행을 표시하는 데 쓴다.
    return { ok: false, busyPort: busy, error: `포트 ${busy} 가 이미 사용 중이다.` };
  }
  // server.js 가 스스로 LOG_FILE 에 기록한다. stdout 까지 같은 파일로 보내면 모든 줄이 두 번 쌓인다.
  // stderr 만 연결해 크래시 스택은 남긴다.
  const err = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [SERVER], { detached: true, stdio: ["ignore", "ignore", err] });
  child.unref();
  // pidfile 은 server.js 가 직접 잡는다(claimPidFile). 여기서 미리 적으면
  // 기동에 실패한 자식의 pid 가 그대로 남아 이후 계속 "중지됨" 으로 보이게 된다.
  await sleep(2000);
  if (!pidAlive(child.pid)) {
    return { ok: false, error: "서버가 기동 직후 종료됐다. " + tailLog(2).join(" / ") };
  }
  return { ok: true, pid: readPid() || child.pid };
}

function stopServer() {
  const pid = readPid();
  let error = null;
  if (pidAlive(pid)) {
    try { process.kill(pid); } catch (e) { error = `pid ${pid} 종료 실패: ${e.message}`; }
  }
  try { fs.unlinkSync(PIDFILE); } catch (e) {}
  return error ? { ok: false, error } : { ok: true };
}

function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(v); } };
    s.on("connect", () => fin(true));
    s.on("error", () => fin(false));
    s.setTimeout(800, () => fin(false));
  });
}

async function status() {
  const pid = readPid();
  const running = pidAlive(pid);
  const ports = {};
  // running 이 아닐 때도 확인한다. pidfile 은 죽었는데 포트가 열려 있는 "유령" 상태를 드러내야
  // 팝업이 원인 없이 "중지됨" 만 보여주는 일이 없다.
  for (const p of ALL_PORTS) ports[p] = await checkPort(p);
  const anyOpen = ALL_PORTS.some((p) => ports[p]);
  return { running, pid: running ? pid : null, ports, orphan: !running && anyOpen };
}

function tailLog(n) {
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n");
    return lines.slice(-n);
  } catch (e) { return []; }
}

async function handle(msg) {
  const cmd = msg && msg.cmd;
  try {
    if (cmd === "start") send(Object.assign({ cmd }, await startServer()));
    else if (cmd === "stop") send(Object.assign({ cmd }, stopServer()));
    else if (cmd === "status") send(Object.assign({ cmd }, await status()));
    else if (cmd === "log") send({ cmd, lines: tailLog(msg.n || 30) });
    else if (cmd === "ping") send({ cmd: "pong" });
    else send({ cmd, ok: false, error: "unknown cmd" });
  } catch (e) {
    send({ cmd, ok: false, error: String(e && e.message) });
  }
}

// 연결 즉시 핸드셰이크 신호
send({ cmd: "ready", host: "com.finsec.host" });
