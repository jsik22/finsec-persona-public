"use strict";
// 멀티포트 mock 서버.
//   - 모든 포트를 한 프로세스에서 동시 바인딩 (HTTP/HTTPS + 하나의 WebSocket)
//   - CORS, OPTIONS preflight, JSON/JSONP, 텍스트(IPinside), self-signed TLS
//   - Veraport / IPinside 전용 프로토콜 처리
// 단독 실행 가능: `node server.js`  (native-host.js 가 데몬으로 spawn)

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { execFileSync } = require("child_process");

const config = require("./config");
const veraport = require("./veraport");
const ipinside = require("./ipinside");
const inisafe = require("./inisafe");
const nxkey = require("./nxkey");

const CERT_DIR = path.join(__dirname, "certs");
const CERT_FILE = path.join(CERT_DIR, "finsec-persona.crt");
const KEY_FILE = path.join(CERT_DIR, "finsec-persona.key");
const LOG_FILE = path.join(__dirname, "server.log");
const PIDFILE = path.join(__dirname, "server.pid");

// pidfile 은 서버가 직접 관리한다. native-host 가 대신 적어주면, 서버를 확장 밖에서 띄우거나
// 재기동했을 때 기록과 실제가 어긋나 "포트는 열려 있는데 관리 대상이 아닌" 상태가 된다.
function claimPidFile() {
  try { fs.writeFileSync(PIDFILE, String(process.pid)); } catch (e) {}
}
function releasePidFile() {
  // 내 pid 일 때만 지운다 — 그 사이 새 서버가 자리를 넘겨받았을 수 있다.
  try {
    if (parseInt(fs.readFileSync(PIDFILE, "utf8"), 10) === process.pid) fs.unlinkSync(PIDFILE);
  } catch (e) {}
}

function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}
function log(msg) {
  const line = `${ts()} ${msg}`;
  try { process.stdout.write(line + "\n"); } catch (e) {}
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {}
}

// ---- 인증서 보장 (없으면 openssl 로 생성) ----
function ensureCert() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) return true;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const san = "IP:127.0.0.1,DNS:localhost,DNS:lx.astxsvc.com,DNS:*.astxsvc.com";
  // CA:FALSE — 신뢰 저장소에 등록되므로 CA 권한이 있으면 키 유출 시 임의 도메인 위조 가능.
  // 825일 — macOS 의 TLS 서버 인증서 유효기간 상한.
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", KEY_FILE, "-out", CERT_FILE, "-days", "825",
      "-subj", "/CN=finsec-persona localhost", "-addext", "subjectAltName=" + san,
      "-addext", "basicConstraints=critical,CA:FALSE",
      "-addext", "keyUsage=critical,digitalSignature,keyEncipherment",
      "-addext", "extendedKeyUsage=serverAuth",
    ], { stdio: "ignore" });
    log("self-signed 인증서 생성: " + CERT_FILE);
    return true;
  } catch (e) {
    log("인증서 생성 실패(openssl 필요): " + e.message);
    return false;
  }
}

// ---- 쿼리 파싱: {key:[values]} ----
function parseQuery(search) {
  const out = {};
  const sp = new URLSearchParams(search || "");
  for (const key of sp.keys()) out[key] = sp.getAll(key);
  return out;
}

// 요청 로깅용. 인증서·라이선스 같은 긴 값만 줄이고 구조는 통째로 남긴다.
// 앞에서 잘라버리면 뒤쪽 필드가 사라져 응답 모양을 맞출 수 없다 — nxKey 의
// callback:"touchenexInterface.TK_..." 이 실제로 800자 절단에 가려져 있었다(2026-09-30).
// 원본을 건드리지 않는다: 여기서 줄인 값이 응답 조립에 새어들면 안 된다.
function compactObj(obj) {
  const shorten = (v) =>
    typeof v === "string" && v.length > 60 ? `<${v.length}자: ${v.slice(0, 24)}…>` : v;
  const out = Object.assign({}, obj);
  if (out.exfunc && Array.isArray(out.exfunc.args)) {
    out.exfunc = Object.assign({}, out.exfunc, { args: out.exfunc.args.map(shorten) });
  }
  for (const k of ["lic", "origin", "cert"]) if (out[k]) out[k] = shorten(out[k]);
  return JSON.stringify(out);
}

function compactBody(body) {
  const decoded = decodeURIComponent(body);
  const eq = decoded.indexOf("=");
  const key = eq > 0 ? decoded.slice(0, eq) : "";
  try {
    return `${key}=${compactObj(JSON.parse(decoded.slice(eq + 1)))}`.slice(0, 1200);
  } catch (e) {
    return decoded.slice(0, 800);
  }
}

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");
  // Chrome 의 Local Network Access: 공개 origin → 루프백 요청은 preflight 에서
  // 이 헤더를 요구한다. 없으면 OPTIONS 만 반복되고 본 요청이 차단된다.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function makeHandler(program, port) {
  function logReq(req) {
    const origin = req.headers.origin || req.headers.referer || "-";
    log(`[${program.name}:${port}] ${req.method} ${req.url}  <- ${origin}`);
  }

  function respond(res, query) {
    // IPinside: " (JSON);" + 텍스트 content-type
    if (program.name === "IPinside LWS Agent") {
      const body = Buffer.from(ipinside.buildBody(query, log), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
      res.end(body);
      return;
    }

    let bodyObj;
    if (program.name === "Veraport" && query.data) bodyObj = veraport.buildResponse(query, log);
    else if (program.name === "INISAFE CrossWeb EX (securePortScan)") bodyObj = inisafe.buildResponse(query, log);
    else bodyObj = config.responseBody(program);

    let text, contentType;
    if (program.format === "jsonp") {
      const cb = (query.callback && query.callback[0]) || (query.cb && query.cb[0]) ||
                 (query.jsoncallback && query.jsoncallback[0]) || null;
      const payload = JSON.stringify(bodyObj);
      text = cb ? `${cb}(${payload});` : payload;
      contentType = "application/javascript; charset=utf-8";
    } else {
      text = JSON.stringify(bodyObj);
      contentType = "application/json; charset=utf-8";
    }
    const buf = Buffer.from(text, "utf8");
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": buf.length });
    res.end(buf);
  }

  return function (req, res) {
    logReq(req);
    corsHeaders(res);
    const u = new URL(req.url, "http://x");
    const query = parseQuery(u.search);

    if (req.method === "OPTIONS") {
      res.writeHead(200, { "Content-Length": 0 });
      res.end();
      return;
    }
    if (req.method === "POST") {
      // Veraport 큰 명령(getVersion/getAxInfo)은 iframe form POST(data=<JSON>) 로 온다.
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (body) {
          // 프로토콜 역분석이 이 프로젝트의 본업이라 본문을 남긴다. 응답 모양을 맞추려면 이게 필요하다.
          log(`    <- body: ${compactBody(body)}`);
          const bp = parseQuery(body);
          for (const k in bp) query[k] = bp[k];
        }
        respond(res, query);
      });
      req.on("error", () => respond(res, query));
      return;
    }
    respond(res, query);
  };
}

// ---- WebSocket (TouchEn nxKey) : 의존성 없이 직접 구현 ----
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function wsAccept(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}
function wsUpgrade(socket, key) {
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n"
  );
}
function wsEncode(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, payload]);
}
function wsDecode(buf) {
  // 단순 단일 프레임 파서 (masked client text). 반환: {opcode, text} 또는 null
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
  let text = "";
  if (masked) {
    const mask = buf.slice(off, off + 4); off += 4;
    const data = buf.slice(off, off + len);
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] ^ mask[i % 4];
    text = out.toString("utf8");
  } else {
    text = buf.slice(off, off + len).toString("utf8");
  }
  return { opcode, text };
}

function startWebSocket() {
  const wsHttp = http.createServer((req, res) => { res.writeHead(426); res.end(); });
  wsHttp.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    const origin = req.headers.origin || "-";
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n"
    );
    log(`[${config.WS_PROGRAM.name}:${config.WS_PORT}] WS connect  <- ${origin}`);
    const hello = { type: "connection", status: "ok", version: config.WS_PROGRAM.version, product: config.WS_PROGRAM.name };
    socket.write(wsEncode(JSON.stringify(hello)));

    socket.on("data", (buf) => {
      const f = wsDecode(buf);
      if (!f) return;
      if (f.opcode === 0x8) { socket.end(); return; }      // close
      if (f.opcode === 0x9) return;                         // ping (무시)
      if (f.opcode === 0x1) {
        log(`[${config.WS_PROGRAM.name}:${config.WS_PORT}] WS recv: ${f.text.slice(0, 200)}`);
        const reply = { type: "response", status: "ok", version: config.WS_PROGRAM.version };
        socket.write(wsEncode(JSON.stringify(reply)));
      }
    });
    socket.on("error", () => {});
  });
  wsHttp.on("error", (e) => log(`WS 서버 오류: ${e.message}`));
  wsHttp.listen(config.WS_PORT, config.HOST, () => {
    log(`listening ws://${config.HOST}:${config.WS_PORT}  (${config.WS_PROGRAM.name})`);
  });
  return wsHttp;
}

// TouchEn nxKey crossEX 데몬 (wss/TLS, 34581~). 프로토콜 조립은 nxkey.js 가 한다.
// 연결 즉시 메시지를 보내지 않는다(버전체크 onmessage 가 hello 를 먼저 먹으면 오판하므로 응답형으로).
function startCrossExWss(port, creds) {
  const srv = https.createServer(creds, (req, res) => { res.writeHead(426); res.end(); });
  srv.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    wsUpgrade(socket, key);
    log(`[TouchEn crossEX:${port}] WS connect ${req.url}`);
    socket.on("data", (buf) => {
      const f = wsDecode(buf);
      if (!f) return;
      if (f.opcode === 0x8) { socket.end(); return; }
      if (f.opcode === 0x9) return;
      if (f.opcode !== 0x1) return;
      let r = null;
      try { r = JSON.parse(f.text); } catch (e) {}   // 포트스캔 탐침은 JSON 이 아니다 → null
      // 구조를 유지한 채 긴 값만 줄인다. Key_Init 은 설정 JSON 과 인증서가 실려 길어서,
      // 앞에서 자르면 정작 필요한 뒤쪽 callback 필드가 안 보인다.
      log(`[TouchEn crossEX:${port}] recv: ${r ? compactObj(r) : f.text.slice(0, 200)}`);
      const out = JSON.stringify(nxkey.buildResponse(r, log));
      // 응답 구조가 이 프로토콜의 핵심 변수다. 보낸 것도 남겨야 recv 만 보고 추측하지 않는다.
      log(`    => sent: ${out.slice(0, 800)}`);
      socket.write(wsEncode(out));
    });
    socket.on("error", () => {});
  });
  srv.on("error", (e) => log(`crossEX wss:${port} 오류: ${e.message}`));
  srv.listen(port, config.HOST, () => log(`listening wss://${config.HOST}:${port}  (TouchEn crossEX)`));
  return srv;
}

// 프로토콜 미상 wss 포트(config.WSS_PROBE). 지금 목적은 통과가 아니라 **기록**이다 —
// 업그레이드를 받아주고 주고받은 프레임을 전부 남긴다. 다수의 검사가 onopen 성공만 보므로
// 이것만으로 통과할 수도 있다. 통과하면 그때 응답을 다듬는다(nxKey 를 그렇게 풀었다).
//
// nxkey.js 는 읽히는 필드가 확정돼서 최소 응답만 보내지만, 여기는 정반대로 **여러 형태를
// 같이 담는다.** 아는 게 없을 때는 넓게 답해 두고 로그로 좁히는 편이 왕복이 적다.
function startProbeWss(port, name, creds) {
  const srv = https.createServer(creds, (req, res) => { res.writeHead(426); res.end(); });
  srv.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    wsUpgrade(socket, key);
    log(`[${name}:${port}] WS connect ${req.url}  <- ${req.headers.origin || "-"}`);
    // 연결 즉시 보내지 않는다. 버전체크 onmessage 가 인사말을 먼저 먹으면 오판하는 구현이 있다.
    socket.on("data", (buf) => {
      const f = wsDecode(buf);
      if (!f) return;
      if (f.opcode === 0x8) { socket.end(); return; }
      if (f.opcode === 0x9) return;
      if (f.opcode !== 0x1) return;
      let r = null;
      try { r = JSON.parse(f.text); } catch (e) {}
      log(`[${name}:${port}] recv: ${r ? compactObj(r) : f.text.slice(0, 400)}`);
      const reply = { result: "success", status: "TRUE", code: "0", errorCode: "0", installed: true };
      if (r) for (const k of ["id", "seq", "tabid", "cmd", "callback", "module"]) if (r[k]) reply[k] = r[k];
      const out = JSON.stringify(reply);
      log(`    => sent: ${out.slice(0, 400)}`);
      socket.write(wsEncode(out));
    });
    socket.on("error", () => {});
  });
  srv.on("error", (e) => log(`${name}:${port} 오류: ${e.message}`));
  srv.listen(port, config.HOST, () => log(`listening wss://${config.HOST}:${port}  (${name})`));
  return srv;
}

// ---- 기동 ----
function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(true));
    s.once("listening", () => s.close(() => resolve(false)));
    s.listen(port, config.HOST);
  });
}

async function main() {
  log("mock security server (node) 시작");
  let creds = null;
  if (config.HAS_HTTPS) {
    if (!ensureCert()) { log("인증서 없음 — HTTPS 포트 시작 불가"); }
    else creds = { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
  }

  let bound = 0;
  for (const portStr of Object.keys(config.PORT_MAP)) {
    const port = parseInt(portStr, 10);
    const program = config.PORT_MAP[port];
    if (await portInUse(port)) { log(`포트 ${port} 이미 사용 중 — ${program.name} 건너뜀`); continue; }
    const handler = makeHandler(program, port);
    let srv;
    if (program.scheme === "https") {
      if (!creds) { log(`[${program.name}:${port}] 인증서 없어 건너뜀`); continue; }
      srv = https.createServer(creds, handler);
    } else {
      srv = http.createServer(handler);
    }
    srv.on("error", (e) => log(`[${program.name}:${port}] 오류: ${e.message}`));
    srv.listen(port, config.HOST, () => log(`listening ${program.scheme}://${config.HOST}:${port}  (${program.name})`));
    bound++;
  }
  // WS 도 미리 확인한다. 바로 listen 하면 충돌 시 EADDRINUSE 가 비동기로 터져 집계가 어긋난다.
  if (await portInUse(config.WS_PORT)) {
    log(`포트 ${config.WS_PORT} 이미 사용 중 — ${config.WS_PROGRAM.name} 건너뜀`);
  } else {
    startWebSocket();
    bound++;
  }
  // TouchEn crossEX wss (TLS) 포트들
  if (creds) {
    for (const p of config.WSS_CROSSEX.ports) {
      if (await portInUse(p)) { log(`포트 ${p} 이미 사용 중 — crossEX 건너뜀`); continue; }
      startCrossExWss(p, creds);
      bound++;
    }
    // 프로토콜 미상 wss (기록 목적)
    for (const p of config.WSS_PROBE) {
      if (await portInUse(p.port)) { log(`포트 ${p.port} 이미 사용 중 — ${p.name} 건너뜀`); continue; }
      startProbeWss(p.port, p.name, creds);
      bound++;
    }
  } else {
    log("인증서 없어 crossEX/probe wss 포트 건너뜀");
  }

  // 하나도 못 잡으면 조용히 종료하지 않는다. 그대로 두면 native-host 가 적어둔 pid 만
  // 죽은 채 pidfile 에 남아 팝업이 원인 없이 "중지됨" 으로 보인다.
  if (bound === 0) {
    log("기동 실패: 포트를 하나도 열지 못했다. 이전 mock 서버가 아직 떠 있거나, 실제 보안 프로그램이 같은 포트를 쓰고 있다.");
    process.exit(1);   // pidfile 을 아직 안 잡았으므로 남길 것도 없다
  }
  claimPidFile();
  process.on("exit", releasePidFile);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    try { process.on(sig, () => process.exit(0)); } catch (e) {}
  }
  log(`활성 리스너 기동 완료 (${bound}개, pid ${process.pid}). (server.js)`);
}

if (require.main === module) {
  main().catch((e) => { log("치명 오류: " + e.message); process.exit(1); });
}

module.exports = { main };
