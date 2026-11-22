$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8

$id = $env:PULSE_CD_ID; $dir = $env:PULSE_CD_DIR; $speed = [int]$env:PULSE_CD_SPEED; $erase = $env:PULSE_CD_ERASE -eq '1'
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
  try {
    if ($erase) { Write-Output 'STAGE|erase'; $e = New-Object -ComObject IMAPI2.MsftDiscFormat2Erase; $e.Recorder = $r; $e.ClientName = 'Pulse'; $e.FullErase = $false; $e.EraseMedia() }
    $tao = New-Object -ComObject IMAPI2.MsftDiscFormat2TrackAtOnce; $tao.Recorder = $r; $tao.ClientName = 'Pulse'
    if ($speed -gt 0) { try { $tao.SetWriteSpeed($speed * 75, $false) } catch {} }
    Write-Output 'STAGE|prepare'; $tao.PrepareMedia()
    $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.pcm' | Sort-Object Name)
    $i = 0
    foreach ($f in $files) {
      $i++; Write-Output ('TRACK|' + $i + '|' + $files.Count)
      $s = [PulseCdStream]::Open($f.FullName); $tao.AddAudioTrack($s); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($s)
    }
    Write-Output 'STAGE|finish'; $tao.ReleaseMedia()
  } finally { }
  Write-Output 'DONE'
} catch { Write-Output ('ERR|' + ('0x{0:X8}' -f $_.Exception.HResult) + '|' + $_.Exception.Message); exit 1 }
