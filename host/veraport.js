"use strict";
// Veraport(WIZVERA Delfino-G3) 요청 처리.
//
// 비동기 handle 폴링 모델: 명령(getOsInfo/getVersion/getAxInfo)을 발행한 뒤
// getResult{handle} 로 결과를 회수한다. getResult 는 직전 명령의 결과를 돌려준다.
//   - getVersion: res.data 는 버전 "문자열"(.replace 대상)
//   - getAxInfo : res.data 는 모듈 "배열", 필드명은 파서 vp_getAxInfo 가 읽는 소문자
//                 (objectname / installstate(1=설치) / objecttype(0=must) ...)
//   - getOsInfo : OS 정보 (Windows 로 응답 — mac 인식 시 일부 모듈 "미지원" 처리 회피)
// 큰 명령(axinfo>2048B)은 iframe POST 본문(data=<JSON>)으로 온다 → server.js 가 본문 파싱.

const VERAPORT_VERSION = "3.8.6.5"; // VP_config.version 이상이어야 통과

let _lastPolicy = []; // 마지막으로 본 정책(axinfo)의 모듈 목록
let _lastResult = ""; // 직전 명령의 결과
const _results = {};  // handle -> 결과

function parseRequest(query) {
  const dataList = query.data;
  if (!dataList || !dataList.length) return { cmd: null, sid: null, inner: {} };
  let outer;
  try { outer = JSON.parse(dataList[0]); } catch (e) { return { cmd: null, sid: null, inner: {} }; }
  return { cmd: outer.cmd, sid: outer.sid, inner: outer.data || {} };
}

function tag(s, name) {
  const m = new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">").exec(s);
  return m ? m[1].trim() : null;
}

// axinfo(base64 CMS) 안 정책 XML 에서 모듈 목록 추출. CMS DER 이지만 XML 은 평문 임베드.
function parsePolicyObjects(axinfo) {
  const objs = [];
  if (!axinfo) return objs;
  let txt;
  try {
    const clean = axinfo.replace(/\\r|\\n|\r|\n/g, "");
    txt = Buffer.from(clean, "base64").toString("latin1");
  } catch (e) { return objs; }
  const re = /<object\s+type="([^"]*)">([\s\S]*?)<\/object>/g;
  let m;
  while ((m = re.exec(txt))) {
    const body = m[2];
    const name = tag(body, "objectName");
    if (!name) continue;
    const ver = (tag(body, "objectVersion") || "").replace(/,/g, ".");
    objs.push({ objectName: name, displayName: tag(body, "displayName") || name, version: ver, type: m[1] });
  }
  return objs;
}

// 정책(axinfo)엔 없지만 일부 사이트가 objectInstList 로 별도 설치체크하는 모듈명.
// 정책에 없으면 vp_getAxInfo(name)==null → "미지원" 으로 진입이 막히므로, 설치됨으로 추가한다.
// (해당 모듈을 안 물어보는 사이트는 이 항목을 무시하므로 무해)
//   - 우리은행(spot.wooribank.com): "NOS"(키보드보안) 가 정책에 없어 미지원 → 진입 차단됨.
const EXTRA_MODULES = [
  { name: "NOS", version: "1.0.0.0", type: "Must" },
];

// 소문자 필드의 axInfo 엔트리 1개 생성 (vp_getAxInfo 파서 규약)
function makeEntry(objectname, displayname, version, typeStr) {
  return {
    objectname: objectname,
    displayname: displayname || objectname,
    objectversion: version,
    localversion: version,
    systemtype: "",
    installstate: 1, // 설치됨
    objecttype: String(typeStr).toLowerCase() === "must" ? 0 : 1,
    forceinstall: "false",
    block: "false",
    killbit: "false",
    allowrun: "true",
    allowrundomains: "",
    updatestate: false,
    objectclsid: "",
    description: "",
    downloadurl: "",
    backupurl: "",
  };
}

// 정책 모듈들을 '설치됨' axInfo 배열로 + EXTRA_MODULES(정책에 없는 것만) 추가
function axEntries(objs) {
  const base = objs.map((o) => makeEntry(o.objectName, o.displayName, o.version, o.type));
  const have = new Set(base.map((e) => e.objectname));
  for (const m of EXTRA_MODULES) if (!have.has(m.name)) base.push(makeEntry(m.name, m.name, m.version, m.type));
  return base;
}

function envelope(cmd, sid, data) {
  return { result: "0", message: "", cmd: cmd, sid: sid, data: data };
}

function commandResult(cmd) {
  if (cmd === "getVersion") return VERAPORT_VERSION; // 문자열
  if (cmd === "getAxInfo") return axEntries(_lastPolicy); // 배열
  // Windows 로 응답: 일부 사이트는 mac 인식 시 Windows 전용 모듈을 "미지원" 처리해 진입 차단.
  if (cmd === "getOsInfo") return { os: "windows", osVersion: "10.0", arch: "x64", is64bit: true };
  if (cmd === "getConfigureJson" || cmd === "getDistributeInfo") return {};
  return null;
}

function handleOf(inner) {
  let obj = inner;
  if (typeof inner === "string") { try { obj = JSON.parse(inner); } catch (e) { return null; } }
  return obj && typeof obj === "object" ? obj.handle : null;
}

function buildResponse(query, log) {
  const { cmd, sid, inner } = parseRequest(query);
  const configure = inner && typeof inner === "object" ? inner.configure : null;
  const axinfo = configure && typeof configure === "object" ? configure.axinfo || "" : "";
  if (log) log(`  veraport cmd=${cmd} sid=${sid}`);

  if (axinfo) {
    const objs = parsePolicyObjects(axinfo);
    if (objs.length) _lastPolicy = objs;
  }

  // 폴링: 직전 명령 결과 반환
  if (cmd === "getResult") {
    const handle = handleOf(inner);
    const result = handle in _results ? _results[handle] : _lastResult;
    if (log) log(`    -> getResult handle=${handle} 결과반환(${Array.isArray(result) ? "array" : typeof result})`);
    return envelope(cmd, sid, result);
  }

  let result = commandResult(cmd);
  if (result === null) {
    if (log) log(`    -> (미정의 cmd, 빈 응답) — 이 cmd 의 기대 응답 확인 필요`);
    result = "";
  } else if (cmd === "getAxInfo") {
    for (const o of _lastPolicy) if (log) log(`    -> ${o.type} ${o.objectName} ${o.version} (installStatus=true)`);
  } else if (log) {
    log(`    -> ${cmd} 결과 준비(${Array.isArray(result) ? "array" : typeof result})`);
  }

  _lastResult = result;
  const handle = configure && typeof configure === "object" ? configure.handle : null;
  if (handle != null) _results[handle] = result;
  return envelope(cmd, sid, result);
}

module.exports = { buildResponse };
