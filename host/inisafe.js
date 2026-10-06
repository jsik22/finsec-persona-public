"use strict";
// INISAFE CrossWeb EX 로컬 데몬 프로토콜 (initech_html5 의 exproto_ext_daemon.js).
// 농협 로그인 페이지에서 실측(2026-09-29)해 확인한 흐름:
//
//   ① dmPortCheckStart — GET https://localhost:4441~4445/?securePortScan<ts>=<blob>
//      200 이 오면 그 포트를 데몬으로 확정하고(sessionStorage.crosswebex_wsport) 스캔을 멈춘다.
//
//   ② sendWS — 확정된 포트로 POST. 본문은 `request=<urlencoded JSON>` 이고
//      JSON 은 { init:"get_versions", m:<모듈명>, lic, cmd:"native", exfunc:{fname:"GetVersion"} … }.
//
//   ③ 응답 처리 — exproto_ext_daemon.js:765 가 먼저 `response.response.status == "TRUE"` 를 본다.
//      이 구조가 아니면 TypeError 로 죽고 미설치 처리된다.
//      통과하면 응답 전체가 daemonVersionCheck(:586) 로 넘어가 최상위의
//      `daemon` / `ex` / `m[]` 을 읽는다. m 은 요청의 모듈명과 이름이 같아야 매칭된다.

const VER = "99.99.99.99"; // diffVersion 통과용으로 충분히 높은 값

// InstallModule 로 설치를 요청받은 모듈. 다음 get_versions 에서 "이미 있다" 고 답해 설치 루프를 끊는다.
//
// 신한은행 실측(2026-09-30): 초기화 후 클라이언트가
//   GetVersion(get_versions) → 필요한 모듈이 m[] 에 없다 → InstallModule(<url>) → 16초 뒤 반복
// 을 무한히 돈다. 요청 URL 의 파일명(INIS60.vcs)을 모듈명으로 삼아 m[] 에 얹으면 루프가 끊긴다.
// (그 URL 은 신한 서버에서 404 라 진짜 데몬도 받지 못한다 — 설치 여부는 응답으로만 판정된다.)
const installed = new Map();

function rememberModule(url) {
  if (typeof url !== "string") return;
  const file = url.split("?")[0].split("/").pop();
  if (!file) return;
  installed.set(file, VER);                             // INIS60.vcs
  const base = file.replace(/\.[^.]+$/, "");            // INIS60
  if (base && base !== file) installed.set(base, VER);
}

function buildResponse(query, log) {
  let req = null;
  const raw = query.request && query.request[0];
  if (raw) {
    try { req = JSON.parse(raw); } catch (e) {}
  }
  // get_versions 는 m, 개별 함수 호출(cmd:"native")은 module 에 모듈명을 싣는다.
  const moduleName = (req && (req.m || req.module)) || "";
  const fname = req && req.exfunc && req.exfunc.fname;
  if (log && req) log(`    -> INISAFE ${fname || req.init || "req"} (m=${moduleName || "-"})`);

  if (fname === "InstallModule" && req.exfunc.args) {
    for (const a of [].concat(req.exfunc.args)) rememberModule(a);
    if (log) log(`       설치된 것으로 기록: ${[...installed.keys()].join(", ")}`);
  }

  // 요청 모듈 + 지금까지 설치 요청받은 모듈을 함께 싣는다. 이름으로 찾으므로 여분은 무해하다.
  const mods = [{ name: moduleName, version: VER }];
  for (const [n, v] of installed) if (n !== moduleName) mods.push({ name: n, version: v });

  // 콜백마다 기대하는 결과 문자열이 다르다. 느슨한 비교가 아니라 상수 비교를 한다.
  //   cwInstallModuleCallback : if (result && result == "1")
  //   cwInitLoadCertCallback  : if (result && "TRUE" == result)
  const replyValue = fname === "InstallModule" ? "1" : "TRUE";

  // cmd:"native" 응답은 CROSSWEBEX.InvokeCallback 이 처리한다. 실측한 그 코드는
  //   response = response.response;      // 안쪽으로 들어가서
  //   var status = response.status;      // status 를 보고
  //   var id     = response.id;          // id 로 exInterfaceArr 의 대기 호출을 찾고
  //   var reply  = response.reply.reply; // 결과를 이중 중첩에서 꺼낸다
  // 로 읽는다. 따라서 id 와 결과는 반드시 response 안쪽에, reply 는 한 겹 더 감싸야 한다.
  // (최상위에 두면 response.reply.reply 에서 TypeError 가 나고 catch 로 빠져 조용히 죽는다)
  const inner = { status: "TRUE", reply: { reply: replyValue } };
  if (req && req.id) inner.id = req.id;

  const out = {
    response: inner,
    // get_versions 경로(CROSSWEBEX_CHECK.daemonVersionCheck)는 최상위에서 읽는다.
    daemon: VER,
    ex: VER,
    m: mods,
    status: true,
    expire: "",
  };

  if (req) {
    if (req.id) out.id = req.id;
    if (req.tabid) out.tabid = req.tabid;
    if (moduleName) out.module = moduleName;
    if (fname) out.exfunc = { fname, ret: replyValue };
    // callback 은 싣지 않는다. 페이지 콜백은 클라이언트가 exInterfaceArr 에 id 로 보관해 두고
    // InvokeCallback 이 직접 꺼내 쓴다 — 요청에도 응답에도 그 이름은 오가지 않는다.
  }
  return out;
}

module.exports = { buildResponse };
