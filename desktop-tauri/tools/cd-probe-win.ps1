# Проверка записи CD на Windows без привода (для CI): что службы IMAPI2 есть, у них есть нужные свойства, и образ
# «диска за один проход» (RawCD, треки подряд) собирается из «сырого» звука так же, как это делает burn.ps1.
$ErrorActionPreference='Stop'
Add-Type -Language CSharp @"
using System; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
public static class PulseCdStream {
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateStreamOnFileEx(string file, uint mode, uint attr, bool create, IntPtr tmpl, out IStream s);
  public static IStream Open(string f) { IStream s; SHCreateStreamOnFileEx(f, 0x20, 0x80, false, IntPtr.Zero, out s); return s; }
}
"@
$fail = 0
function ok($c, $m) { if ($c) { Write-Output ('ok   ' + $m) } else { Write-Output ('FAIL ' + $m); $script:fail++ } }
$tao = New-Object -ComObject IMAPI2.MsftDiscFormat2TrackAtOnce
ok ($tao | Get-Member -Name DoNotFinalizeMedia) 'TAO: DoNotFinalizeMedia (оставить диск открытым)'
ok ($tao | Get-Member -Name SupportedWriteSpeeds) 'TAO: SupportedWriteSpeeds (скорости привода)'
$raw = New-Object -ComObject IMAPI2.MsftDiscFormat2RawCD
ok ($raw | Get-Member -Name SupportedSectorTypes) 'RawCD: SupportedSectorTypes'
ok ($raw | Get-Member -Name WriteMedia) 'RawCD: WriteMedia'
$rec = New-Object -ComObject IMAPI2.MsftDiscRecorder2
ok ($rec | Get-Member -Name EjectMedia) 'Recorder: EjectMedia'
# два «трека»: 3 с и 2,5 с тишины/тона, длина кратна сектору 2352
$d = Join-Path $env:TEMP ('pulse-cd-probe-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory $d | Out-Null
$lens = 375, 338   # по стандарту трек не короче 4 с (300 секторов)
for ($k = 0; $k -lt 2; $k++) { $b = New-Object byte[] ($lens[$k] * 2352); for ($i = 0; $i -lt $b.Length; $i += 4) { $v = [int](8000 * [math]::Sin($i / 4 * 2 * [math]::PI * 440 / 44100)); $b[$i] = $v -band 255; $b[$i + 1] = ($v -shr 8) -band 255; $b[$i + 2] = $b[$i]; $b[$i + 3] = $b[$i + 1] }; [IO.File]::WriteAllBytes((Join-Path $d ('{0:D2}.pcm' -f ($k + 1))), $b) }
foreach ($st in 2, 3, 1) {
  try {
    $img = New-Object -ComObject IMAPI2.MsftRawCDImageCreator; $img.ResultingImageType = $st; $img.DisableGaplessAudio = $false
    foreach ($f in (Get-ChildItem -LiteralPath $d -Filter '*.pcm' | Sort-Object Name)) { $s = [PulseCdStream]::Open($f.FullName); [void]$img.AddTrack(0, $s) }
    $res = $img.CreateResultImage()
    ok ($null -ne $res) ('RawCD ' + $st + ': образ собран; треков ' + $img.NumberOfExistingTracks + ', начало выводной зоны ' + $img.StartOfLeadout + ' сект.')
    ok (@(563, 713) -contains [int]$img.StartOfLeadout) ('RawCD ' + $st + ': треки подряд, без пауз между ними (выводная зона с ' + $img.StartOfLeadout + ')')
  } catch { Write-Output ('FAIL RawCD вид ' + $st + ': ' + $_.Exception.Message); $fail++ }
}
Remove-Item -Recurse -Force $d
Write-Output ('ИТОГ: ' + $(if ($fail) { "$fail ошибок" } else { 'всё на месте' }))
