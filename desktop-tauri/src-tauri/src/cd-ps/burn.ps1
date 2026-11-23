$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8

# Запись аудио-CD через службу записи дисков Windows (IMAPI2).
#  • пауза между треками 2 с и больше — «трек за треком» (TAO): 2 с ставит сам привод, лишнее — тишина в конце трека
#    (её добавляет программа заранее); можно оставить диск открытым (DoNotFinalizeMedia);
#  • пауза меньше 2 с и «без пауз» — «диск за один проход» (RawCD, DAO): треки подряд, тишина — тоже в конце трека;
#    такой диск всегда закрывается.
$id = $env:PULSE_CD_ID; $dir = $env:PULSE_CD_DIR; $speed = [int]$env:PULSE_CD_SPEED; $erase = $env:PULSE_CD_ERASE -eq '1'
$eject = $env:PULSE_CD_EJECT -eq '1'; $close = $env:PULSE_CD_CLOSE -ne '0'; $dao = $env:PULSE_CD_DAO -eq '1'
Add-Type -Language CSharp @"
using System; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
public static class PulseCdStream {
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateStreamOnFileEx(string file, uint mode, uint attr, bool create, IntPtr tmpl, out IStream s);
  public static IStream Open(string f) { IStream s; SHCreateStreamOnFileEx(f, 0x20, 0x80, false, IntPtr.Zero, out s); return s; }
}
"@
try {
  $r = New-Object -ComObject IMAPI2.MsftDiscRecorder2; $r.InitializeDiscRecorder($id)
  $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.pcm' | Sort-Object Name)
  if ($erase) { Write-Output 'STAGE|erase'; $e = New-Object -ComObject IMAPI2.MsftDiscFormat2Erase; $e.Recorder = $r; $e.ClientName = 'Pulse'; $e.FullErase = $false; $e.EraseMedia() }
  if ($dao) {
    Write-Output 'STAGE|prepare'
    $raw = New-Object -ComObject IMAPI2.MsftDiscFormat2RawCD; $raw.Recorder = $r; $raw.ClientName = 'Pulse'
    # вид секторов: какой привод умеет (2 — «готовые» подканалы, 3 — сырые, 1 — только P и Q)
    $types = @($raw.SupportedSectorTypes | ForEach-Object { [int]$_ }); $st = 0
    foreach ($k in 2, 3, 1) { if ($types -contains $k) { $st = $k; break } }
    if (-not $st) { throw (New-Object System.Exception 'Привод не умеет писать диск за один проход — выберите паузу 2 секунды') }
    $img = New-Object -ComObject IMAPI2.MsftRawCDImageCreator; $img.ResultingImageType = $st; $img.DisableGaplessAudio = $false
    foreach ($f in $files) { $s = [PulseCdStream]::Open($f.FullName); [void]$img.AddTrack(0, $s) }
    $res = $img.CreateResultImage()
    $raw.RequestedSectorType = $st
    if ($speed -gt 0) { try { $raw.SetWriteSpeed($speed * 75, $false) } catch {} }
    $raw.PrepareMedia()
    Write-Output ('WRITEALL|' + $files.Count + '|' + [int]$img.StartOfLeadout)
    $raw.WriteMedia($res)
    Write-Output 'STAGE|finish'; $raw.ReleaseMedia()
  } else {
    $tao = New-Object -ComObject IMAPI2.MsftDiscFormat2TrackAtOnce; $tao.Recorder = $r; $tao.ClientName = 'Pulse'
    if ($speed -gt 0) { try { $tao.SetWriteSpeed($speed * 75, $false) } catch {} }
    if (-not $close) { $tao.DoNotFinalizeMedia = $true }
    Write-Output 'STAGE|prepare'; $tao.PrepareMedia()
    $i = 0
    foreach ($f in $files) {
      $i++; Write-Output ('TRACK|' + $i + '|' + $files.Count)
      $s = [PulseCdStream]::Open($f.FullName); $tao.AddAudioTrack($s); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($s)
    }
    Write-Output 'STAGE|finish'; $tao.ReleaseMedia()
  }
  if ($eject) { try { $r.EjectMedia() } catch { } }
  Write-Output 'DONE'
} catch { Write-Output ('ERR|' + ('0x{0:X8}' -f $_.Exception.HResult) + '|' + $_.Exception.Message); exit 1 }
