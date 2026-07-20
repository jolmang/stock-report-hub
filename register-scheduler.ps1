# register-scheduler.ps1
# 이 스크립트를 한 번 실행하면, Windows 작업 스케줄러에 매일 아침 8시 자동 실행 작업이 등록됩니다.
# 반드시 PowerShell을 "관리자 권한으로 실행" 한 뒤 이 스크립트를 실행해 주세요.

$TaskName     = "ReportHub-Collect"
$BatFilePath  = "e:\Download\CODE\Antigravity\Test2\run-collect.bat"
$LogDir       = "e:\Download\CODE\Antigravity\Test2\logs"

# 로그 폴더가 없으면 자동으로 만듭니다.
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
    Write-Host "✅ 로그 폴더 생성됨: $LogDir"
}

# 혹시 이미 같은 이름의 작업이 등록되어 있다면 먼저 삭제합니다.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "🗑️ 기존 작업 '$TaskName' 삭제됨"
}

# 매일 아침 8:00에 배치 파일을 실행하는 작업을 등록합니다.
$Action   = New-ScheduledTaskAction -Execute $BatFilePath
$Trigger  = New-ScheduledTaskTrigger -Daily -At "08:00AM"
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action   $Action `
    -Trigger  $Trigger `
    -Settings $Settings `
    -RunLevel Highest `
    -Force | Out-Null

Write-Host ""
Write-Host "=========================================="
Write-Host "🎉 작업 스케줄러 등록 완료!"
Write-Host "  - 작업 이름  : $TaskName"
Write-Host "  - 실행 시간  : 매일 오전 8:00"
Write-Host "  - 실행 파일  : $BatFilePath"
Write-Host "  - 로그 저장  : $LogDir\collect.log"
Write-Host "=========================================="
Write-Host ""
Write-Host "💡 지금 즉시 테스트 실행하려면 아래 명령어를 붙여넣으세요:"
Write-Host "   Start-ScheduledTask -TaskName '$TaskName'"
