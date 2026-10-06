# finsec-persona

국내 금융·공공 사이트가 확인하는 로컬 보안 프로그램의 응답을 모사하는 Node.js 서버와 이를 제어하는 Chromium 확장 프로그램입니다.

실제 키보드 보안, 전자서명, 악성코드 차단 기능은 제공하지 않습니다. 본인 소유의 기기와 계정에서만 사용하세요.

## 요구 사항

- Node.js
- Chrome, Edge, Brave 등 Chromium 기반 브라우저

## 설치

### Windows

1. 이 저장소를 내려받습니다.
2. 브라우저에서 `chrome://extensions`를 열고 **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드**를 눌러 `extension` 폴더를 선택합니다.
4. 화면에 표시된 확장 프로그램 ID를 복사합니다.
5. 저장소 폴더에서 다음 명령을 실행합니다.

```bat
install.bat <확장 프로그램 ID> -TrustCert
```

6. 인증서 경고를 확인해 승인하고 브라우저를 다시 시작합니다.

### macOS / Linux

1. 위 Windows 절의 1~4단계와 같은 방법으로 확장을 등록합니다.
2. 저장소 폴더에서 다음 명령을 실행합니다.

```sh
./install.sh <확장 프로그램 ID>
```

3. 생성된 `host/certs/finsec-persona.crt`를 운영체제 또는 브라우저의 신뢰 저장소에 등록하고 브라우저를 다시 시작합니다.

macOS에서는 다음 명령으로 등록할 수 있습니다.

```sh
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain host/certs/finsec-persona.crt
```

## 사용법

1. 브라우저 툴바에서 finsec-persona 아이콘을 엽니다.
2. **시작**을 눌러 로컬 서버를 실행합니다.
3. 대상 사이트가 로컬 네트워크 접근 권한을 요청하면 허용합니다.
4. 필요한 경우 현재 사이트의 `navigator.platform` 위장 모드를 선택하고 페이지를 새로고침합니다.
5. 사용을 마치면 확장 팝업에서 **중지**를 누릅니다.

팝업의 **서버 로그**에서 최근 요청을 확인할 수 있습니다.

## 라이선스

[MIT](LICENSE)
