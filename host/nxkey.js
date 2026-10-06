"use strict";
// TouchEn nxKey crossEX 데몬 프로토콜 (RaonSecure).
// 신한은행 로그인 페이지에서 실측 + 페이지 소스 확인으로 계약 전체를 확정했다(2026-09-30).
//
// nxKey 와 INISAFE CrossWeb EX 는 같은 crossEX 스펙의 두 구현체다. 추측이 아니라 확인된 사실이다:
//   - TOUCHENEX 의 멤버가 CROSSWEBEX 와 이름까지 같다(exInterfaceArr / Invoke / InvokeCallback …)
//   - nxKey 코드가 쓰는 디버그 로거 exlog 가 CROSSWEBEX_CONST.debug 를 스위치로 본다
//   - lic 봉투 형식이 같고 protocol_name 만 "touchenex" / "crosswebex" 로 갈린다
// 그래도 계약이 세부에서 다르므로(아래 "버전" 항목) 한쪽에서 확정한 걸 그대로 옮기면 안 된다.
//
// ── 호출 흐름 ─────────────────────────────────────────────────────────────
//   ① 포트스캔 — wss://127.0.0.1:34581~34583 에 붙어 아무 메시지나 던진다. 오는 본문은 문자열
//      "[object Object]" 다(클라가 객체를 그대로 send 해 코어션된 것). 내용은 보지 않고
//      "응답이 오는가" 만 보므로, JSON 이 아니어도 뭐든 답하면 데몬으로 인식된다.
//      포트 범위는 페이지의 touchenexInfo.exEdgeInfo 가 알려준다
//      (edgeStartPort:34581, portChkCnt:3 — config.js 의 WSS_CROSSEX 와 일치).
//
//   ② init:"get_versions" (m:"nxkey") — 설치 판정. 최상위 daemon / ex / m[] 을 읽는다.
//
//   ③ cmd:"setcallback" (fname:"new") — 페이지가 콜백 채널을 등록한다. 우리가 보관할 건 없다.
//
//   ④ cmd:"native" (Key_Init / Key_Start / Key_Stop / Request …) — 결과가 3단을 거쳐 전달된다.
//
// ── 응답에서 실제로 읽히는 필드 ───────────────────────────────────────────
// TOUCHENEX.InvokeCallback 소스를 읽어 확인했다. 읽는 곳은 세 군데뿐이다:
//     response = response.response;
//     var status = response.status;        // "TRUE" 여야 성공 경로
//     var id     = response.id;            // exInterfaceArr 에서 대기 호출을 찾아 splice
//     var reply  = response.reply.reply;   // 결과
// 그 밖은 넣어도 무시된다. 특히:
//   - callbackid 는 요청에 실려 오지만 응답에서 읽히지 않는다.
//   - callback 도 실을 필요가 없다. 요청에 "touchenexInterface.TK_InitCallback" 이 실려 오지만,
//     페이지 콜백 이름은 클라이언트가 Invoke 시점에 보관해 두고 funcInfo.EXCallback /
//     funcInfo.pageCallback 으로 직접 꺼내 쓴다(INISAFE 와 같다).
//
// ── 버전: INISAFE 와 다른 지점이 아니라, 같은 지점 ─────────────────────────
// TOUCHENEX_UTIL.diffVersion 은 네 성분을 왼쪽부터 보는 평범한 >= 비교다(소스 확인).
// 따라서 충분히 높은 값 하나로 daemonVersionCheck 의 3관문(daemon → ex → m[])을 모두 통과한다.
// 한때 "nxKey 는 정확한 버전을 요구한다" 고 봤지만 diffVersion("99.99.99.99","1.0.2.10") === true
// 로 반증됐다. 사이트별 하드코딩은 불필요하다.
//
// ── 콜백별 payload: 문자열이냐 객체냐 ─────────────────────────────────────
// InvokeCallback 이 reply 의 타입에 따라 다르게 조립하므로 타입이 계약의 일부다.
//     function TK_Init_callback(result) {
//         if (result.isvm == "true")   { shbComm.hideProcessMessage(); useTouchEnNxInit = false; … }
//         if (result.result == "true") { bInit = 1; makeEncDataId(); … blur(); focus(); … }
//     }
//     function TK_Stop_callback(result) {}        // 빈 함수 — 무엇을 보내도 무관
// 즉 Key_Init 은 문자열이 아니라 객체를 요구한다. 문자열을 보내면 result.result 가 undefined 라
// 두 분기가 조용히 건너뛰어진다 — 예외조차 없다. Key_Stop 을 93회 받아도 아무 신호가 없던 이유다.
//
// ── 도달 한계 (2026-09-30 실측) ────────────────────────────────────────────
//   {result:"true"} → 입력칸이 실제로 활성화된다. blur()/focus() 가 돌아 커서가 잡힌다.
//                     하지만 같은 블록의 makeEncDataId() 가 입력 권한을 모듈에 넘기고,
//                     이어서 필드마다 Key_Start 를 발행한다(실측 102회). 거기서 끝이다 —
//                     nxKey 의 본업은 드라이버 수준에서 키 입력을 가로채 암호화해 넘기는 것이라,
//                     실제 모듈이 없으면 페이지가 기다리는 키 입력이 애초에 생기지 않는다.
//                     응답 형식으로 해결되는 종류의 문제가 아니다.
//   {isvm:"true"}   → 오버레이는 걷히지만 입력칸이 안 열린다(blur/focus 가 result 분기에만 있다).
//   둘 다           → 미검증. 두 분기는 else if 가 아니라 독립된 if 라서 동시에 켤 수 있다.
//                     useTouchEnNxInit=false 가 입력 경로에서 체크된다면 활성화를 얻고 권한 이관만
//                     막을 여지가 남아 있다 — 다만 아래 이유가 맞다면 결과는 같을 것이다.
//
// 그래서 이 사이트에서 실제 로그인까지 가는 길은 nxKey 에뮬레이션이 아니라 navigator 위장(macOS)이다.
// 위장이 통하는 건 우연이 아니라 원리적이다 — 페이지가 nxKey 경로를 아예 타지 않아
// 입력 가로채기 핸들러가 설치되지 않는다.
//
// 아래 기본값은 그 경계를 눈으로 보이기 위한 것이다. 설치·초기화 게이트는 응답만으로 완전히
// 통과되고(입력칸이 열리는 것이 그 증거), 실제 암호 연산은 넘지 못한다.

const VER = "99.99.99.99"; // diffVersion 은 성분별 >= 비교 — 충분히 높으면 3관문 모두 통과

// 콜백마다 기대하는 payload 가 다르다. INISAFE 에서 결과 문자열이 "1" / "TRUE" 로 갈렸던 것의
// 객체판이다. 소스로 확정한 것만 적는다.
const REPLY_BY_FNAME = {
  Key_Init: { result: "true" },
};
const DEFAULT_REPLY = "0"; // TK_Stop_callback 처럼 결과를 보지 않는 쪽이 대부분이다

// 객체 payload 는 한 겹 더 싼다. 3단을 거쳐 페이지 핸들러에 닿기 때문이다:
//   ① InvokeCallback   : reply = response.reply.reply → 객체면 reply.callback 을 심고 TK_InitCallback(reply)
//   ② TK_InitCallback  : eval(result.callback)(result.reply)   ← 래퍼의 .reply 를 넘긴다
//   ③ TK_Init_callback : result.result / result.isvm 을 본다
// 문자열은 ①의 string 분기가 {callback, reply} 를 알아서 조립하므로 그대로 둔다.
function wrapReply(payload) {
  return payload && typeof payload === "object" ? { reply: payload } : payload;
}

// 최상위 에코. TOUCHENEX_DAEMON.sendWS 가 tabid/module/cmd 로 요청을 추적하므로 돌려준다.
function withEcho(req, out) {
  if (!req) return out;
  for (const k of ["id", "tabid", "module", "cmd"]) if (req[k]) out[k] = req[k];
  return out;
}

// req: 파싱된 요청 객체. 포트스캔 탐침처럼 JSON 이 아니면 null 이 온다.
// (inisafe.js 는 POST 쿼리를 받는다 — 전송이 달라서 생긴 차이다)
function buildResponse(req, log) {
  // ② 설치 판정 — daemonVersionCheck 가 최상위에서 읽는다.
  if (req && req.init === "get_versions") {
    if (log) log(`    -> get_versions 응답(설치됨, m=${req.m})`);
    return withEcho(req, {
      daemon: VER,
      ex: VER,
      m: [{ name: req.m || "nxkey", version: VER }],
      status: true, // false 면 라이선스 검증 실패로 처리된다
      expire: "",
    });
  }

  // ④ native 및 그 외 — id 와 결과를 response 안쪽에, 결과는 reply 를 한 겹 더 감싼다.
  const fname = req && req.exfunc && req.exfunc.fname;
  const payload = (fname && REPLY_BY_FNAME[fname]) || DEFAULT_REPLY;
  const inner = { status: "TRUE", reply: { reply: wrapReply(payload) } };
  if (req && req.id) inner.id = req.id;

  if (log && req) {
    log(`    -> ${fname || req.cmd || "스텁"} 응답 (reply=${JSON.stringify(payload)})`);
  }
  return withEcho(req, { response: inner });
}

module.exports = { buildResponse };
