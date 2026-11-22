$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8

try { $dm = New-Object -ComObject IMAPI2.MsftDiscMaster2 } catch { Write-Output 'END'; exit 0 }
foreach ($id in $dm) {
  try {
    $r = New-Object -ComObject IMAPI2.MsftDiscRecorder2; $r.InitializeDiscRecorder($id)
    $name = (($r.VendorId + ' ' + $r.ProductId) -replace '\s+', ' ').Trim()
    $letter = ''; if ($r.VolumePathNames) { $letter = [string]($r.VolumePathNames | Select-Object -First 1) }
    $media = 'none'; $free = 0
    $d = New-Object -ComObject IMAPI2.MsftDiscFormat2Data
    if (-not $d.IsRecorderSupported($r)) { $media = 'nowrite' }
    elseif ($d.IsCurrentMediaSupported($r)) {
      $d.Recorder = $r; $t = [int]$d.CurrentPhysicalMediaType; $blank = $d.MediaHeuristicallyBlank
      if ($t -eq 2 -or $t -eq 3) {
        if ($blank) { $media = 'blank'; $tao = New-Object -ComObject IMAPI2.MsftDiscFormat2TrackAtOnce; $tao.Recorder = $r; try { $free = [int]$tao.TotalSectorsOnMedia } catch { $free = 0 } }
        elseif ($t -eq 3) { $media = 'rw' } else { $media = 'used' }
      } else { $media = 'notcd' }
    }
    Write-Output ('DRIVE|' + $id + '|' + $name + '|' + $letter + '|' + $media + '|' + $free)
  } catch { Write-Output ('ERR|' + $_.Exception.Message) }
}
Write-Output 'END'
