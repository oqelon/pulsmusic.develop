$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8

$r = New-Object -ComObject IMAPI2.MsftDiscRecorder2; $r.InitializeDiscRecorder($env:PULSE_CD_ID); try { $r.EjectMedia() } catch {}
Write-Output 'DONE'
