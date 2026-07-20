@echo off
REM 매일 아침 8시에 Windows 작업 스케줄러가 이 파일을 실행합니다.
REM collect-and-mail.ts 스크립트를 실행하여 리포트 수집 및 메일 발송을 자동 수행합니다.

cd /d "e:\Download\CODE\Antigravity\Test2"
npm run collect >> "e:\Download\CODE\Antigravity\Test2\logs\collect.log" 2>&1
