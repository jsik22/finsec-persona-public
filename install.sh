#!/bin/sh
# finsec-persona — 네이티브 메시징 호스트 등록 + 인증서 생성.
# 사용법: ./install.sh <확장 ID>
#   확장 ID 는 chrome://extensions 에서 "압축해제된 확장 프로그램을 로드" 후 표시되는 값.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$DIR/host"
EXT_ID="$1"

if [ -z "$EXT_ID" ]; then
  echo "사용법: ./install.sh <확장 ID>"
  echo "  1) chrome://extensions → 개발자 모드 ON → '압축해제된 확장 프로그램을 로드' → extension/ 폴더 선택"
  echo "  2) 표시된 확장 ID 를 복사해 인자로 전달"
  exit 1
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "오류: node 가 PATH 에 없습니다 (node 설치 필요)"; exit 1; fi

# 1) self-signed 인증서 (모든 HTTPS 포트 + lx.astxsvc.com 커버)
#    CA:FALSE — 신뢰 저장소에 등록되므로 CA 권한이 있으면 키 유출 시 임의 도메인 위조 가능.
if [ ! -f "$HOST_DIR/certs/finsec-persona.crt" ]; then
  mkdir -p "$HOST_DIR/certs"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$HOST_DIR/certs/finsec-persona.key" -out "$HOST_DIR/certs/finsec-persona.crt" \
    -days 825 -subj "/CN=finsec-persona localhost" \
    -addext "subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:lx.astxsvc.com,DNS:*.astxsvc.com" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" 2>/dev/null
  echo "✓ 인증서 생성: $HOST_DIR/certs/finsec-persona.crt"
else
  echo "· 인증서 이미 있음: $HOST_DIR/certs/finsec-persona.crt"
fi

# 2) 네이티브 호스트 실행 wrapper (node 절대경로 고정 — 크롬은 최소 환경으로 실행하므로)
WRAP="$HOST_DIR/run-host.sh"
printf '#!/bin/sh\nexec "%s" "%s"\n' "$NODE" "$HOST_DIR/native-host.js" > "$WRAP"
chmod +x "$WRAP"
echo "✓ wrapper: $WRAP  (node=$NODE)"

# 3) 네이티브 메시징 매니페스트를 설치된 크로미움 계열 브라우저마다 등록
MANIFEST="{
  \"name\": \"com.finsec.host\",
  \"description\": \"finsec-persona native host\",
  \"path\": \"$WRAP\",
  \"type\": \"stdio\",
  \"allowed_origins\": [\"chrome-extension://$EXT_ID/\"]
}"

REGISTERED=0
for base in \
  "$HOME/Library/Application Support/Google/Chrome" \
  "$HOME/Library/Application Support/Google/Chrome Canary" \
  "$HOME/Library/Application Support/Chromium" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" \
  "$HOME/Library/Application Support/Microsoft Edge" ; do
  if [ -d "$base" ]; then
    mkdir -p "$base/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST" > "$base/NativeMessagingHosts/com.finsec.host.json"
    echo "✓ 등록: $base/NativeMessagingHosts/com.finsec.host.json"
    REGISTERED=1
  fi
done
[ "$REGISTERED" = 0 ] && echo "⚠ 크로미움 계열 브라우저 디렉터리를 못 찾음 — 수동 등록 필요"

echo ""
echo "다음:"
echo "  1) 인증서 신뢰 등록 (1회):"
echo "     sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"$HOST_DIR/certs/finsec-persona.crt\""
echo "  2) 브라우저 재시작 → 확장 팝업에서 [시작]"
echo "  3) 사이트별 'Windows 위장' 토글은 필요할 때만 (ASTX 사이트는 끄기)"
