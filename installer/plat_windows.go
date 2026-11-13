//go:build windows

package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	pMsgBox  = user32.NewProc("MessageBoxW")
	pMetrics = user32.NewProc("GetSystemMetrics")
	pDpi     = user32.NewProc("GetDpiForSystem")
	pFree    = kernel32.NewProc("GetDiskFreeSpaceExW")
	pMutex   = kernel32.NewProc("CreateMutexW")
)

const createNoWindow = 0x08000000

func u16(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }

func msgBox(text, title string, flags uintptr) int {
	r, _, _ := pMsgBox.Call(0, uintptr(unsafe.Pointer(u16(text))), uintptr(unsafe.Pointer(u16(title))), flags)
	return int(r)
}

func fatal(msg string) { msgBox(msg, AppName, 0x10) } // MB_ICONERROR

func singleInstance() bool {
	h, _, err := pMutex.Call(0, 0, uintptr(unsafe.Pointer(u16("PulseDesktopAlphaSetup"))))
	if h == 0 {
		return true
	}
	if errno, ok := err.(syscall.Errno); ok && errno == 183 { // ERROR_ALREADY_EXISTS
		msgBox("Установщик «Пульса» уже открыт.", AppName, 0x40)
		return false
	}
	return true
}

func diskFreeMB(dir string) int {
	d := filepath.Clean(dir)
	for d != "" {
		if _, err := os.Stat(d); err == nil {
			break
		}
		p := filepath.Dir(d)
		if p == d {
			break
		}
		d = p
	}
	var free uint64
	r, _, _ := pFree.Call(uintptr(unsafe.Pointer(u16(d))), uintptr(unsafe.Pointer(&free)), 0, 0)
	if r == 0 {
		return 0
	}
	return int(free >> 20)
}

func winArch() string {
	a := strings.ToUpper(os.Getenv("PROCESSOR_ARCHITEW6432") + " " + os.Getenv("PROCESSOR_ARCHITECTURE"))
	if strings.Contains(a, "ARM64") {
		return "arm64"
	}
	return "x64"
}

func hidden(c *exec.Cmd) *exec.Cmd {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return c
}

// PowerShell со сценарием в виде -EncodedCommand (UTF-16): русские имена и пути проходят без искажений
func runPS(script string, env map[string]string, sta bool) (string, error) {
	full := "[Console]::OutputEncoding=[Text.Encoding]::UTF8\n$ErrorActionPreference='Stop'\n" + script
	u := utf16.Encode([]rune(full))
	b := make([]byte, len(u)*2)
	for i, v := range u {
		b[2*i] = byte(v)
		b[2*i+1] = byte(v >> 8)
	}
	args := []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"}
	if sta {
		args = append(args, "-STA")
	}
	args = append(args, "-EncodedCommand", base64.StdEncoding.EncodeToString(b))
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if _, err := os.Stat(ps); err != nil {
		ps = "powershell.exe"
	}
	c := hidden(exec.Command(ps, args...))
	c.Env = os.Environ()
	for k, v := range env {
		c.Env = append(c.Env, k+"="+v)
	}
	out, err := c.CombinedOutput()
	s := strings.TrimSpace(string(out))
	if err != nil {
		return s, fmt.Errorf("%v %s", err, s)
	}
	return s, nil
}

func killApp(dir string) {
	runPS(`$p = Get-Process -Name Pulse -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -ieq $env:P_EXE) }
if ($p) { $p | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 700 }`, map[string]string{"P_EXE": filepath.Join(dir, ExeName)}, false)
}

const lnkPS = `$w = New-Object -ComObject WScript.Shell
function L($path) { $s = $w.CreateShortcut($path); $s.TargetPath = $env:P_EXE; $s.WorkingDirectory = $env:P_DIR; $s.IconLocation = $env:P_ICO + ',0'; $s.Description = 'Пульс — музыка в дизайне «Пульса»'; $s.Save() }
$name = $env:P_NAME + '.lnk'
foreach ($k in @('Desktop','Programs','Startup')) {
  $p = Join-Path ([Environment]::GetFolderPath($k)) $name
  $on = @{ Desktop = $env:P_DESK; Programs = $env:P_START; Startup = $env:P_AUTO }[$k]
  if ($on -eq '1') { L $p } elseif (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
}
# обновить значки на рабочем столе
try { Add-Type -Namespace W -Name S -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, int f, System.IntPtr a, System.IntPtr b);'; [W.S]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero) } catch {}
Write-Output ([Environment]::GetFolderPath('Desktop'))`

func b01(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

func makeShortcuts(exe, dir, ico string, o Opts) error {
	_, err := runPS(lnkPS, map[string]string{"P_EXE": exe, "P_DIR": dir, "P_ICO": ico, "P_NAME": AppName,
		"P_DESK": b01(o.Desktop), "P_START": b01(o.StartMenu), "P_AUTO": b01(o.Autostart)}, false)
	return err
}

const regPS = `$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PulseDesktopAlpha'
New-Item -Path $k -Force | Out-Null
Set-ItemProperty -Path $k -Name DisplayName -Value $env:P_NAME
Set-ItemProperty -Path $k -Name DisplayVersion -Value $env:P_VER
Set-ItemProperty -Path $k -Name Publisher -Value 'Pulse'
Set-ItemProperty -Path $k -Name DisplayIcon -Value $env:P_ICO
Set-ItemProperty -Path $k -Name InstallLocation -Value $env:P_DIR
Set-ItemProperty -Path $k -Name UninstallString -Value ('"' + $env:P_UNINST + '" --uninstall')
New-ItemProperty -Path $k -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $k -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $k -Name EstimatedSize -Value ([int]$env:P_KB) -PropertyType DWord -Force | Out-Null`

func registerUninstall(dir, exe, ico, uninst string, kb int) {
	runPS(regPS, map[string]string{"P_NAME": AppName, "P_VER": AppVersion, "P_ICO": ico, "P_DIR": dir, "P_UNINST": uninst, "P_KB": fmt.Sprint(kb)}, false)
}

// ---------- выбор папки ----------
// Современное окно Проводника «Выбор папки» (IFileOpenDialog с FOS_PICKFOLDERS). Владелец — окно установщика,
// поэтому выбор открывается поверх него, а не прячется сзади. Не получилось — запасной вариант через PowerShell.
var (
	ole32     = syscall.NewLazyDLL("ole32.dll")
	shell32   = syscall.NewLazyDLL("shell32.dll")
	pCoInit   = ole32.NewProc("CoInitializeEx")
	pCoUninit = ole32.NewProc("CoUninitialize")
	pCoCreate = ole32.NewProc("CoCreateInstance")
	pCoFree   = ole32.NewProc("CoTaskMemFree")
	pItemFrom = shell32.NewProc("SHCreateItemFromParsingName")
	pEnumWin  = user32.NewProc("EnumWindows")
	pWinText  = user32.NewProc("GetWindowTextW")
	pVisible  = user32.NewProc("IsWindowVisible")
	pSetFg    = user32.NewProc("SetForegroundWindow")
)

type guid struct {
	a    uint32
	b, c uint16
	d    [8]byte
}

var (
	clsidFileOpen = guid{0xDC1C5A9C, 0xE88A, 0x4DDE, [8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7}}
	iidFileOpen   = guid{0xD57C7288, 0xD4AD, 0x4768, [8]byte{0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60}}
	iidShellItem  = guid{0x43826D1E, 0xE718, 0x42EE, [8]byte{0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE}}
)

// метод COM-объекта по номеру в таблице
func vcall(obj uintptr, idx int, args ...uintptr) uintptr {
	vt := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vt + uintptr(idx)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{obj}, args...)...)
	return r
}

// окно установщика (Edge в режиме приложения) — по заголовку страницы
func setupWindow() uintptr {
	var found uintptr
	cb := syscall.NewCallback(func(h, _ uintptr) uintptr {
		if v, _, _ := pVisible.Call(h); v == 0 {
			return 1
		}
		buf := make([]uint16, 256)
		pWinText.Call(h, uintptr(unsafe.Pointer(&buf[0])), 256)
		if strings.HasPrefix(syscall.UTF16ToString(buf), "Установка — Пульс") {
			found = h
			return 0
		}
		return 1
	})
	pEnumWin.Call(cb, 0)
	return found
}

type pickRes struct {
	path string
	err  error
}

func pickDirNative(cur string) (string, error) {
	ch := make(chan pickRes, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		hr, _, _ := pCoInit.Call(0, 2) // COINIT_APARTMENTTHREADED
		if int32(hr) >= 0 {
			defer pCoUninit.Call()
		}
		var dlg uintptr
		if hr, _, _ := pCoCreate.Call(uintptr(unsafe.Pointer(&clsidFileOpen)), 0, 1, uintptr(unsafe.Pointer(&iidFileOpen)), uintptr(unsafe.Pointer(&dlg))); int32(hr) < 0 || dlg == 0 {
			ch <- pickRes{"", fmt.Errorf("CoCreateInstance 0x%x", uint32(hr))}
			return
		}
		defer vcall(dlg, 2) // Release
		opt := new(uint32)
		vcall(dlg, 10, uintptr(unsafe.Pointer(opt)))        // GetOptions
		vcall(dlg, 9, uintptr(*opt|0x20|0x40|0x800|0x1000)) // SetOptions: PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST | FILEMUSTEXIST
		title, okLbl := u16("Куда установить Пульс"), u16("Выбрать папку")
		vcall(dlg, 17, uintptr(unsafe.Pointer(title))) // SetTitle
		vcall(dlg, 18, uintptr(unsafe.Pointer(okLbl))) // SetOkButtonLabel
		runtime.KeepAlive(title)
		runtime.KeepAlive(okLbl)
		runtime.KeepAlive(opt)
		// открыть рядом с текущей папкой
		start := filepath.Dir(filepath.Clean(cur))
		for start != "" {
			if fi, err := os.Stat(start); err == nil && fi.IsDir() {
				break
			}
			p := filepath.Dir(start)
			if p == start {
				start = ""
				break
			}
			start = p
		}
		if start != "" {
			var item uintptr
			sp := u16(start)
			hr, _, _ := pItemFrom.Call(uintptr(unsafe.Pointer(sp)), 0, uintptr(unsafe.Pointer(&iidShellItem)), uintptr(unsafe.Pointer(&item)))
			runtime.KeepAlive(sp)
			if int32(hr) >= 0 && item != 0 {
				vcall(dlg, 12, item) // SetFolder
				vcall(item, 2)
			}
		}
		owner := setupWindow()
		hr = vcall(dlg, 3, owner)     // Show
		if uint32(hr) == 0x800704C7 { // отмена
			ch <- pickRes{"", nil}
			return
		}
		if int32(hr) < 0 {
			ch <- pickRes{"", fmt.Errorf("Show 0x%x", uint32(hr))}
			return
		}
		resp := new(uintptr)
		hr = vcall(dlg, 20, uintptr(unsafe.Pointer(resp))) // GetResult
		res := *resp
		if int32(hr) < 0 || res == 0 {
			ch <- pickRes{"", fmt.Errorf("GetResult 0x%x", uint32(hr))}
			return
		}
		defer vcall(res, 2)
		namep := new(*uint16)
		hr = vcall(res, 5, 0x80058000, uintptr(unsafe.Pointer(namep))) // GetDisplayName(SIGDN_FILESYSPATH)
		name := *namep
		if int32(hr) < 0 || name == nil {
			ch <- pickRes{"", fmt.Errorf("GetDisplayName 0x%x", uint32(hr))}
			return
		}
		path := utf16PtrToString(name)
		pCoFree.Call(uintptr(unsafe.Pointer(name)))
		if owner != 0 {
			pSetFg.Call(owner) // вернуть окно установщика на передний план
		}
		ch <- pickRes{path, nil}
	}()
	r := <-ch
	return r.path, r.err
}

func utf16PtrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	var s []uint16
	for i := uintptr(0); ; i += 2 {
		c := *(*uint16)(unsafe.Pointer(uintptr(unsafe.Pointer(p)) + i))
		if c == 0 {
			break
		}
		s = append(s, c)
	}
	return string(utf16.Decode(s))
}

func pickDirPS(cur string) (string, error) {
	out, err := runPS(`Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'CenterScreen'; Size = (New-Object System.Drawing.Size 1,1) }
$owner.Show(); $owner.Activate()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Куда установить Пульс'
$d.ShowNewFolderButton = $true
if ($env:P_DIR -and (Test-Path -LiteralPath (Split-Path $env:P_DIR -Parent))) { $d.SelectedPath = (Split-Path $env:P_DIR -Parent) }
$r = $d.ShowDialog($owner); $owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }`, map[string]string{"P_DIR": cur}, true)
	if err != nil {
		return "", err
	}
	lines := strings.Split(strings.ReplaceAll(out, "\r", ""), "\n")
	return strings.TrimSpace(lines[len(lines)-1]), nil
}

// "" и nil — пользователь нажал «Отмена»
func pickDir(cur string) (string, error) {
	p, err := pickDirNative(cur)
	if err == nil {
		return p, nil
	}
	return pickDirPS(cur)
}

// запуск «как с ярлыка»: через Проводник — программа не становится «дочкой» установщика
// и получает обычное окружение пользователя (как при следующих запусках с рабочего стола)
func launchApp(exe, dir string) error {
	ex := filepath.Join(os.Getenv("SystemRoot"), "explorer.exe")
	if _, err := os.Stat(ex); err == nil {
		c := exec.Command(ex, exe)
		c.Dir = dir
		if err := c.Start(); err == nil {
			go c.Wait()
			return nil
		}
	}
	c := exec.Command(exe)
	c.Dir = dir
	return c.Start()
}

func hideProc(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }

// Windows 10 (сборка 10240) и новее: на 7 / 8 / 8.1 программа (Electron 33) не работает
var pRtlVer = syscall.NewLazyDLL("ntdll.dll").NewProc("RtlGetVersion")

func osCheck() string {
	type osv struct {
		size, major, minor, build, platform uint32
		csd                                 [128]uint16
	}
	v := osv{}
	v.size = uint32(unsafe.Sizeof(v))
	pRtlVer.Call(uintptr(unsafe.Pointer(&v)))
	if v.major != 0 && (v.major < 10 || v.build < 10240) {
		return fmt.Sprintf("«%s» работает на Windows 10 и Windows 11.\n\nУ вас Windows %d.%d (сборка %d) — на ней программа не запустится.", AppName, v.major, v.minor, v.build)
	}
	return ""
}

// ---------- окно установщика: Edge (или Chrome) в режиме приложения ----------
func findBrowser() string {
	pf, pf86, la := os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")
	for _, p := range []string{
		filepath.Join(pf86, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(la, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(la, `Google\Chrome\Application\chrome.exe`),
	} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func openWindow(url string) func() {
	b := findBrowser()
	if b == "" {
		exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
		return func() {}
	}
	prof, _ := os.MkdirTemp("", "pulse-setup-")
	// размер и положение — в единицах без учёта масштаба экрана (как их понимает Edge)
	dpi, _, _ := pDpi.Call()
	if dpi == 0 {
		dpi = 96
	}
	sw, _, _ := pMetrics.Call(0)
	sh, _, _ := pMetrics.Call(1)
	W, H := 960, 660
	x := int(sw)*96/int(dpi)/2 - W/2
	y := int(sh)*96/int(dpi)/2 - H/2
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}
	c := exec.Command(b, "--app="+url, "--user-data-dir="+prof, "--no-first-run", "--no-default-browser-check",
		"--disable-sync", "--disable-extensions", "--hide-crash-restore-bubble", "--force-dark-mode",
		"--disable-features=Translate,msEdgeTranslate,msImplicitSignin,msEdgeSidebarV2",
		fmt.Sprintf("--window-size=%d,%d", W, H), fmt.Sprintf("--window-position=%d,%d", x, y))
	if err := c.Start(); err != nil {
		exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
		return func() {}
	}
	started := time.Now()
	go func() {
		c.Wait()
		// если браузер «передал» окно другому процессу и сразу вышел — это не закрытие окна
		if time.Since(started) > 4*time.Second {
			close(windowClosed)
		}
	}()
	return func() {
		if c.Process != nil {
			c.Process.Kill()
		}
		time.Sleep(500 * time.Millisecond)
		os.RemoveAll(prof)
	}
}

// ---------- удаление ----------
func uninstall() {
	exe, _ := os.Executable()
	dir := filepath.Dir(exe)
	if _, err := os.Stat(filepath.Join(dir, "pulse-install.json")); err != nil {
		fatal("Не нашёл установленный «Пульс» рядом с этим файлом.")
		return
	}
	if msgBox("Удалить «"+AppName+"» с компьютера?\n\nВаш вход в Яндекс Музыку, любимые треки и настройки останутся — если поставите «Пульс» снова, всё будет на месте.", AppName, 0x4|0x20) != 6 { // MB_YESNO|MB_ICONQUESTION → IDYES
		return
	}
	killApp(dir)
	runPS(`$name = $env:P_NAME + '.lnk'
foreach ($k in @('Desktop','Programs','Startup')) { $p = Join-Path ([Environment]::GetFolderPath($k)) $name; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force } }
Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PulseDesktopAlpha' -Recurse -Force -ErrorAction SilentlyContinue`, map[string]string{"P_NAME": AppName}, false)
	// папку (вместе с этим файлом) удаляет cmd через пару секунд после выхода
	c := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe"))
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow,
		CmdLine: `/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q "` + dir + `"`}
	c.Start()
	msgBox("«"+AppName+"» удалён.", AppName, 0x40)
}
