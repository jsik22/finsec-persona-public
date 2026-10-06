"use strict";
// 포트/버전/응답 설정.
// Veraport / IPinside 는 전용 모듈(veraport.js / ipinside.js)이 처리하며, 아래 version/payload 는 폴백용.

const HOST = "127.0.0.1";

// format: "json" | "jsonp"  (WebSocket 은 server.js 가 별도 처리)
const PROGRAMS = [
  { name: "MagicLine4NX", ports: [19006], scheme: "http", format: "json",
    version: "1.0.0.27", payload: { installed: true, product: "MagicLine4NX" } },

  // 실제 처리는 ipinside.js (installCheck/datacollector). 아래는 폴백.
  { name: "IPinside LWS Agent", ports: [21300], scheme: "https", format: "jsonp",
    version: "3.0.0.6", payload: { result: "success", product: "IPinside" } },

  // 실제 처리는 veraport.js. 16105 도 https.
  { name: "Veraport", ports: [16105, 16106], scheme: "https", format: "jsonp",
    version: "3.8.6.5", payload: { result: "success", product: "Veraport-G3" } },

  { name: "AhnLab Safe Transaction", ports: [12380, 15530], scheme: "http", format: "json",
    version: "2.4.0.1", payload: { installed: true, product: "AhnLab Safe Transaction" } },

  // ASTX2: lx.astxsvc.com:55920~ (공개DNS상 127.0.0.1). /ASTX2/hello result 가 "ACK" 면 설치됨.
  // 신한은행 실측(2026-09-30): 고정 포트가 아니라 55920 부터 위로 스캔한다(55920→55921→55922…).
  // 세션마다 시작점이 올라가므로 여유 있게 열어둔다.
  { name: "AhnLab Safe Transaction (ASTX2)",
    ports: [55920, 55921, 55922, 55923, 55924, 55925, 55926, 55927, 55928, 55929],
    scheme: "https", format: "jsonp",
    version: "2.0", payload: { result: "ACK" } },

  { name: "INISAFE CrossWeb EX", ports: [7710, 7711], scheme: "http", format: "json",
    version: "3.3.2.32", payload: { installed: true, product: "INISAFE CrossWeb EX" } },

  // 농협 실측(2026-09-29): crosswebex6.js 의 exproto_ext_daemon 이
  //   https://localhost:4441 ~ 4445 를 ?securePortScan<ts>=<blob> 로 순차 스캔한다.
  //   7710/7711(http) 과는 별개 경로.
  //   ① dmPortCheckStart: GET 이 200 이면 그 포트를 데몬으로 확정하고 스캔 중단
  //   ② sendWS: 이어지는 요청의 응답에서 `response.response.status == "TRUE"` 를 읽는다
  //      (exproto_ext_daemon.js:765). 이 구조가 아니면 TypeError 로 미설치 처리된다.
  { name: "INISAFE CrossWeb EX (securePortScan)", ports: [4441, 4442, 4443, 4444, 4445],
    scheme: "https", format: "json",
    version: "3.3.2.32", payload: { response: { status: "TRUE" } } },

  { name: "nProtect Online Security", ports: [16100], scheme: "http", format: "json",
    version: "1.1.3.4", payload: { installed: true, product: "nProtect Online Security" } },

  // 우리은행 실측(2026-09-30): nProtect NOS 를 https 14440 으로 직접 찌른다.
  //   GET https://127.0.0.1:14440/?code=<토큰>&dummy=<캐시버스터>  → ERR_CONNECTION_REFUSED
  // 응답 계약 미상. 우선 열어서 무엇을 보내고 무엇을 읽는지 기록한다.
  // 스캔하는지도 아직 모른다 — 로그에 14441 이상이 보이면 범위를 넓힌다(ASTX2 가 그랬다).
  { name: "nProtect NOS (keyboard)", ports: [14440, 14441, 14442, 14443],
    scheme: "https", format: "jsonp",
    version: "1.1.3.4", payload: { result: "success", installed: true } },
];

const WS_PORT = 34580;
const WS_PROGRAM = { name: "TouchEn nxKey", version: "1.0.0.90" };

// TouchEn nxKey crossEX 데몬: wss(TLS) 포트 스캔(34581~). 첫 응답 포트를 데몬으로 인식하고
// /<site>/<proto>/Call 로 get_versions 질의. (TouchEnNx_daemon.js 의 wsPortScanWorker)
// 이 범위는 페이지가 직접 알려준다 — touchenexInfo.exEdgeInfo 의
// edgeStartPort:34581 + portChkCnt:3 과 정확히 일치한다(신한 실측 2026-09-30).
// 프로토콜 처리는 nxkey.js. 거기 주석에 계약과 도달 한계가 정리돼 있다.
const WSS_CROSSEX = { ports: [34581, 34582, 34583], name: "TouchEn nxKey (crossEX wss)" };

// 프로토콜 미상의 wss 포트. 우리은행 실측(2026-09-30) 콘솔에 그대로 찍혔다:
//   WebSocket connection to 'wss://127.0.0.1:21400/' failed    (IPinside_v6_engine.js)
//   WebSocket connection to 'wss://localhost:10531/' failed    ([AnySign for PC] AnySign_GetWebSocket)
//
// ★ 우리은행은 Veraport 자기보고를 믿지 않고 포트를 직접 찌른다. macOS 실측에서 얻은
//   "Veraport 게이트가 나머지를 대신 보증한다" 는 결론이 Windows 에서는 성립하지 않는다.
//   21300(https, IPinside LWS)과 21400(wss, IPinside v6 engine)은 별개 경로다.
//
// 계약을 모르므로 목적은 "연결을 받아주고 전부 기록" 이다. 다수의 검사가 onopen 성공만
// 보므로 업그레이드만으로 통과할 수도 있다 — 통과하면 그때 응답을 다듬는다.
const WSS_PROBE = [
  { port: 21400, name: "IPinside v6 engine (wss)" },
  { port: 10531, name: "AnySign4PC (wss)" },
];

const PORT_MAP = {};
for (const p of PROGRAMS) for (const port of p.ports) PORT_MAP[port] = p;

// HTTPS 가 필요한지
const HAS_HTTPS = PROGRAMS.some((p) => p.scheme === "https");

function responseBody(program) {
  return Object.assign({}, program.payload, { version: program.version });
}

module.exports = { HOST, PROGRAMS, WS_PORT, WS_PROGRAM, WSS_CROSSEX, WSS_PROBE, PORT_MAP, HAS_HTTPS, responseBody };
