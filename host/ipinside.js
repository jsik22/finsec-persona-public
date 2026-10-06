"use strict";
// IPinside LWS Agent (interezen NPIv6) 요청 처리.
//
// Chrome 경로는 진짜 JSONP 아님 — 텍스트로 받아 e.replace(/ \(|\);/g,"") 후 JSON.parse.
//   => 응답 본문은 " (" + JSON + ");" 형태, Content-Type 은 텍스트여야 함(server.js 가 지정).
//   installCheck(t=V): result 가 "I" 여야 LatestInstalled(설치됨). 그 외는 "T"(미설치).
//   datacollector(t=A): 같은 응답의 udata/ndata/wdata 를 읽음. udata 비면 "정보수집 실패".
//     udata 는 문자열, "Tl2iuGO6ZETyn9d1tB6"/"_IRE|"/"_IRN|" 접두사는 피한다.
// 한계: udata 는 본래 서버 검증용 암호화 블록 → mock 값은 클라이언트 게이트만 통과시킴.

const UDATA = "TW9ja1VkYXRhX25vdF9hX3JlYWxfYWdlbnRfdmFsdWVfMDAwMQ==";
const NDATA = "TW9ja05kYXRhMDAwMQ==";
const WDATA = "TW9ja1dkYXRhMDAwMQ==";

function buildBody(query, log) {
  const t = (query.t && query.t[0]) || "";
  const payload = { result: "I", isvalidate: "1", udata: UDATA, ndata: NDATA, wdata: WDATA };
  if (log) log(`  ipinside t=${t} -> result=I (udata 제공)`);
  // compact JSON (응답 파서 정규식 / \(|\); 에 걸릴 ' (' / ');' 회피)
  return " (" + JSON.stringify(payload) + ");";
}

module.exports = { buildBody };
