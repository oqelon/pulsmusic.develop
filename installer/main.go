// Установщик «Пульс Десктоп Альфа».
//
// Как устроен:
//   - окно установщика — страница в дизайне «Пульса», которую показывает Microsoft Edge в режиме приложения
//     (Edge есть в каждой Windows 10/11); сама страница вшита в этот exe и общается с установщиком
//     через локальный адрес 127.0.0.1 с секретным ключом — снаружи к нему не подключиться;
//   - «Пульс» — это Electron (внутри уже есть свой Node.js и Chromium). Electron скачивается при установке
//     с GitHub (или с зеркала npmmirror, если GitHub недоступен) и проверяется по контрольной сумме;
//     файлы самого «Пульса» вшиты в этот exe;
//   - ставится в %LOCALAPPDATA%\Programs\Pulse (права администратора не нужны), ярлык «Пульс Десктоп Альфа» —
//     на рабочий стол и в меню «Пуск», запись — в «Установку и удаление программ».
//   - запуск с --uninstall — удаление (так его вызывает Windows из «Установки и удаления программ»).
package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	AppName         = "Пульс Десктоп Альфа"
	AppVersion      = "0.11.1"
	ElectronVersion = "33.2.1"
	ExeName         = "Pulse.exe"
	needMB          = 420 // распакованный Electron + «Пульс» + запас (для ARM ещё и архив)
)

//go:embed ui/index.html
var uiHTML string

//go:embed all:app
var appFS embed.FS

//go:embed pulse.ico
var icoData []byte

// Electron для обычных компьютеров (x64) вшит в установщик — интернет при установке не нужен.
// Для Windows на ARM установщик скачивает свою сборку Electron.
//
//go:embed electron/electron-v33.2.1-win32-x64.zip
var electronX64 []byte

const electronX64SHA = "c325a6d905c67107e166267813ea2151ae7fd316c0a88de0081db0b9851a9946" // из SHASUMS256.txt релиза v33.2.1

// ---------- состояние установки (его читает окно) ----------
type State struct {
	Phase  string  `json:"phase"` // idle | installing | done | error | cancelled
	Pct    float64 `json:"pct"`
	Step   int     `json:"step"` // 0 место · 1 Electron · 2 распаковка · 3 ярлыки
	Detail string  `json:"detail"`
	Eta    string  `json:"eta"`
	Err    string  `json:"err"`
	Cached bool    `json:"cached"`
	Dir    string  `json:"dir"`
}

type Opts struct {
	Dir       string `json:"dir"`
	Desktop   bool   `json:"desktop"`
	StartMenu bool   `json:"startMenu"`
	Autostart bool   `json:"autostart"`
}

var (
	mu       sync.Mutex
	st       = State{Phase: "idle"}
	cancelFn context.CancelFunc
	lastSeen = time.Now()
	quitCh   = make(chan struct{}, 1)
)

func set(f func(s *State)) { mu.Lock(); f(&st); mu.Unlock() }
func get() State           { mu.Lock(); defer mu.Unlock(); return st }

func defaultDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		h, _ := os.UserHomeDir()
		base = filepath.Join(h, "AppData", "Local")
	}
	return filepath.Join(base, "Programs", "Pulse")
}

func cacheDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "PulseDesktop", "cache")
}

// ---------- установка ----------
func runInstall(ctx context.Context, o Opts) error {
	dir := filepath.Clean(strings.Trim(strings.TrimSpace(o.Dir), `"`))
	if !filepath.IsAbs(dir) || (runtime.GOOS == "windows" && len(filepath.VolumeName(dir)) == 0) {
		return fmt.Errorf("Укажите полный путь к папке, например C:\\Users\\Имя\\AppData\\Local\\Programs\\Pulse")
	}
	set(func(s *State) {
		s.Phase = "installing"
		s.Step = 0
		s.Pct = 1
		s.Detail = "Проверяю место на диске"
		s.Err = ""
		s.Eta = ""
		s.Dir = dir
	})
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("не получилось создать папку %s: %v", dir, err)
	}
	if free := diskFreeMB(dir); free > 0 && free < needMB {
		return fmt.Errorf("мало места на диске: свободно %d МБ, нужно около %d МБ", free, needMB)
	}
	killApp(dir) // если «Пульс» из этой папки сейчас открыт — закрываем, иначе файлы не перезаписать
	set(func(s *State) { s.Pct = 2 })

	// 1. Electron
	arch := winArch()
	zipName := fmt.Sprintf("electron-v%s-win32-%s.zip", ElectronVersion, arch)
	if err := os.MkdirAll(cacheDir(), 0o755); err != nil {
		return err
	}
	var zr *zip.Reader
	if arch == "x64" && len(electronX64) > 0 {
		set(func(s *State) {
			s.Step = 1
			s.Pct = 40
			s.Cached = true
			s.Detail = "Electron уже внутри установщика"
		})
		if h := sha256.Sum256(electronX64); hex.EncodeToString(h[:]) != electronX64SHA {
			return errors.New("установщик повреждён (не совпала контрольная сумма Electron) — скачайте его заново")
		}
		r, err := zip.NewReader(bytes.NewReader(electronX64), int64(len(electronX64)))
		if err != nil {
			return fmt.Errorf("установщик повреждён — скачайте его заново: %v", err)
		}
		zr = r
		set(func(s *State) { s.Pct = 70 })
	} else {
		zipPath := filepath.Join(cacheDir(), zipName)
		if err := fetchElectron(ctx, zipName, zipPath); err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		zf, err := zip.OpenReader(zipPath)
		if err != nil {
			os.Remove(zipPath)
			return fmt.Errorf("скачанный Electron повреждён — нажмите «Повторить»: %v", err)
		}
		defer zf.Close()
		zr = &zf.Reader
	}

	// 2. распаковка
	set(func(s *State) {
		s.Step = 2
		s.Pct = 72
		s.Detail = "Распаковываю программу"
		s.Eta = ""
	})
	// старую установку «Пульса» убираем целиком (только если это действительно наша папка)
	if _, err := os.Stat(filepath.Join(dir, "pulse-install.json")); err == nil {
		for _, sub := range []string{"locales", "resources"} {
			os.RemoveAll(filepath.Join(dir, sub))
		}
	}
	if err := unzipTo(ctx, zr, dir, func(f float64) { set(func(s *State) { s.Pct = 72 + 18*f }) }); err != nil {
		return fmt.Errorf("не получилось распаковать Electron: %v", err)
	}
	exe := filepath.Join(dir, ExeName)
	os.Remove(exe)
	if err := os.Rename(filepath.Join(dir, "electron.exe"), exe); err != nil {
		return fmt.Errorf("не нашёл electron.exe в архиве: %v", err)
	}
	os.Remove(filepath.Join(dir, "resources", "default_app.asar"))

	// файлы «Пульса» → resources\app
	appDir := filepath.Join(dir, "resources", "app")
	os.RemoveAll(appDir)
	err := fs.WalkDir(appFS, "app", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(p, "app")
		target := filepath.Join(appDir, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := appFS.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
	if err != nil {
		return fmt.Errorf("не получилось записать файлы программы: %v", err)
	}
	ico := filepath.Join(dir, "pulse.ico")
	if err := os.WriteFile(ico, icoData, 0o644); err != nil {
		return err
	}

	// проверка: все ли файлы на месте и целые (антивирус или нехватка места могли что-то не дать записать)
	set(func(s *State) { s.Pct = 91; s.Detail = "Проверяю установленные файлы" })
	if miss := verifyInstall(dir, zr); len(miss) > 0 {
		repairInstall(dir, zr, miss)
		if miss2 := verifyInstall(dir, zr); len(miss2) > 0 {
			return fmt.Errorf("не хватает файлов программы (%s). Похоже, их заблокировал антивирус — добавьте папку %s в исключения и нажмите «Повторить»", short(miss2), dir)
		}
	}
	set(func(s *State) { s.Pct = 92 })

	// 3. ярлыки, удаление, отметка об установке
	set(func(s *State) { s.Step = 3; s.Detail = "Ярлыки и меню «Пуск»" })
	uninst := filepath.Join(dir, "uninstall.exe")
	if self, err := os.Executable(); err == nil && !samePath(self, uninst) {
		copyFile(self, uninst)
	}
	info, _ := json.MarshalIndent(map[string]any{"version": AppVersion, "electron": ElectronVersion, "arch": arch, "opts": o, "at": time.Now().Format(time.RFC3339)}, "", "  ")
	os.WriteFile(filepath.Join(dir, "pulse-install.json"), info, 0o644)
	if err := makeShortcuts(exe, dir, ico, o); err != nil {
		return fmt.Errorf("программа установлена, но ярлык не создался: %v", err)
	}
	set(func(s *State) { s.Pct = 94 })
	registerUninstall(dir, exe, ico, uninst, dirSizeKB(dir))

	// пробный запуск: «Пульс» тихо открывается без окна, проверяет, что интерфейс загрузился, и закрывается.
	// Не получилось с видеокартой — пробуем без неё и, если так работает, включаем безопасный режим.
	if os.Getenv("PULSE_SETUP_NOSELFTEST") != "1" {
		set(func(s *State) {
			s.Pct = 96
			s.Detail = "Проверяю, что «Пульс» запускается"
		})
		killApp(dir)
		ok, why := selfTest(exe, dir)
		if !ok {
			set(func(s *State) {
				s.Pct = 98
				s.Detail = "Проверяю запуск без ускорения видеокартой"
			})
			ok2, why2 := selfTest(exe, dir, "--disable-gpu")
			if ok2 {
				markSafeMode()
			} else {
				if _, err := os.Stat(exe); err != nil {
					return fmt.Errorf("файл %s пропал после установки — скорее всего, его удалил антивирус. Добавьте папку %s в исключения антивируса и нажмите «Повторить»", ExeName, dir)
				}
				return fmt.Errorf("программа установлена, но не запускается: %s (без видеокарты: %s). Журнал: %s", why, why2, filepath.Join(appData(), "logs", "pulse.log"))
			}
		}
	}
	set(func(s *State) { s.Pct = 100; s.Phase = "done"; s.Detail = "" })
	return nil
}

// ---------- проверка установки ----------
func verifyInstall(dir string, zr *zip.Reader) []string {
	var miss []string
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || strings.HasSuffix(f.Name, "default_app.asar") {
			continue
		}
		name := f.Name
		if name == "electron.exe" {
			name = ExeName
		}
		fi, err := os.Stat(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil || fi.Size() != int64(f.UncompressedSize64) {
			miss = append(miss, name)
		}
	}
	fs.WalkDir(appFS, "app", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		info, _ := d.Info()
		fi, e := os.Stat(filepath.Join(dir, "resources", "app", filepath.FromSlash(strings.TrimPrefix(p, "app/"))))
		if e != nil || (info != nil && fi.Size() != info.Size()) {
			miss = append(miss, "resources/app/"+strings.TrimPrefix(p, "app/"))
		}
		return nil
	})
	return miss
}

// дописываем то, чего не хватает
func repairInstall(dir string, zr *zip.Reader, miss []string) {
	want := map[string]bool{}
	for _, m := range miss {
		want[m] = true
	}
	for _, f := range zr.File {
		name := f.Name
		if name == "electron.exe" {
			name = ExeName
		}
		if !want[name] {
			continue
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(target), 0o755)
		if rc, err := f.Open(); err == nil {
			if out, err := os.Create(target); err == nil {
				io.Copy(out, rc)
				out.Close()
			}
			rc.Close()
		}
	}
	for m := range want {
		if strings.HasPrefix(m, "resources/app/") {
			if b, err := appFS.ReadFile("app/" + strings.TrimPrefix(m, "resources/app/")); err == nil {
				t := filepath.Join(dir, filepath.FromSlash(m))
				os.MkdirAll(filepath.Dir(t), 0o755)
				os.WriteFile(t, b, 0o644)
			}
		}
	}
}

func short(l []string) string {
	if len(l) > 4 {
		return strings.Join(l[:4], ", ") + fmt.Sprintf(" и ещё %d", len(l)-4)
	}
	return strings.Join(l, ", ")
}

// %APPDATA%\Pulse — здесь «Пульс» хранит настройки, журнал и perf.json
func appData() string {
	base := os.Getenv("APPDATA")
	if base == "" {
		h, _ := os.UserHomeDir()
		base = filepath.Join(h, "AppData", "Roaming")
	}
	return filepath.Join(base, "Pulse")
}

// пробный запуск «Pulse.exe --pulse-selftest <файл>»: программа сама пишет в файл, получилось ли
func selfTest(exe, dir string, extra ...string) (bool, string) {
	out := filepath.Join(os.TempDir(), "pulse-selftest-"+token()+".json")
	defer os.Remove(out)
	c := exec.Command(exe, append([]string{"--pulse-selftest", out}, extra...)...)
	c.Dir = dir
	hideProc(c)
	if err := c.Start(); err != nil {
		return false, "не удалось запустить " + ExeName + ": " + err.Error()
	}
	done := make(chan error, 1)
	go func() { done <- c.Wait() }()
	select {
	case <-done:
	case <-time.After(45 * time.Second):
		c.Process.Kill()
		<-done
		return false, "программа не ответила за 45 секунд"
	}
	b, err := os.ReadFile(out)
	if err != nil {
		code := -1
		if c.ProcessState != nil {
			code = c.ProcessState.ExitCode()
		}
		return false, fmt.Sprintf("программа закрылась с ошибкой (код %d)", code)
	}
	var r struct {
		Ok  bool   `json:"ok"`
		Why string `json:"why"`
	}
	json.Unmarshal(b, &r)
	return r.Ok, r.Why
}

// безопасный режим: «Пульс» будет запускаться без ускорения видеокартой (это можно выключить в профиле)
func markSafeMode() {
	p := filepath.Join(appData(), "perf.json")
	m := map[string]any{}
	if b, err := os.ReadFile(p); err == nil {
		json.Unmarshal(b, &m)
	}
	m["safe"] = 1
	m["boot"] = "ok"
	os.MkdirAll(filepath.Dir(p), 0o755)
	b, _ := json.Marshal(m)
	os.WriteFile(p, b, 0o644)
}

// Electron: из кэша, если уже скачан и цел; иначе с GitHub, а если не вышло — с зеркала
func fetchElectron(ctx context.Context, name, dst string) error {
	set(func(s *State) { s.Step = 1; s.Pct = 3; s.Detail = "Скачиваю Electron" })
	bases := []string{
		"https://github.com/electron/electron/releases/download/v" + ElectronVersion + "/",
		"https://npmmirror.com/mirrors/electron/" + ElectronVersion + "/",
		"https://registry.npmmirror.com/-/binary/electron/v" + ElectronVersion + "/",
	}
	want := ""
	for _, b := range bases {
		if sum, err := shaFor(ctx, b+"SHASUMS256.txt", name); err == nil {
			want = sum
			break
		}
	}
	if fi, err := os.Stat(dst); err == nil && fi.Size() > 40<<20 {
		if want == "" || fileSHA(dst) == want {
			set(func(s *State) { s.Cached = true; s.Pct = 70; s.Detail = "Electron уже скачан" })
			return nil
		}
		os.Remove(dst)
	}
	var last error
	for _, b := range bases {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		err := download(ctx, b+name, dst+".part")
		if err != nil {
			last = err
			continue
		}
		if want != "" && fileSHA(dst+".part") != want {
			last = errors.New("файл скачался с ошибкой (не совпала контрольная сумма)")
			os.Remove(dst + ".part")
			continue
		}
		os.Remove(dst)
		return os.Rename(dst+".part", dst)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return fmt.Errorf("не получилось скачать Electron — проверьте интернет (и VPN, если включён). %v", last)
}

var httpc = &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, DialContext: (&net.Dialer{Timeout: 20 * time.Second}).DialContext, TLSHandshakeTimeout: 20 * time.Second, ResponseHeaderTimeout: 30 * time.Second}}

func shaFor(ctx context.Context, url, name string) (string, error) {
	c, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(c, "GET", url, nil)
	r, err := httpc.Do(req)
	if err != nil {
		return "", err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return "", fmt.Errorf("ответ %d", r.StatusCode)
	}
	sc := bufio.NewScanner(io.LimitReader(r.Body, 1<<20))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name && len(f[0]) == 64 {
			return strings.ToLower(f[0]), nil
		}
	}
	return "", errors.New("нет суммы")
}

func fileSHA(p string) string {
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil))
}

func download(ctx context.Context, url, dst string) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", "PulseDesktopSetup/"+AppVersion)
	r, err := httpc.Do(req)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return fmt.Errorf("сервер ответил %d", r.StatusCode)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer f.Close()
	total := r.ContentLength
	var done int64
	start := time.Now()
	buf := make([]byte, 256<<10)
	lastUI := time.Time{}
	for {
		n, err := r.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return werr
			}
			done += int64(n)
			if time.Since(lastUI) > 120*time.Millisecond {
				lastUI = time.Now()
				frac, eta := 0.0, ""
				if total > 0 {
					frac = float64(done) / float64(total)
					if el := time.Since(start).Seconds(); el > 1.5 && done > 0 {
						left := el / frac * (1 - frac)
						eta = humanLeft(left)
					}
				}
				d := fmt.Sprintf("%d из %d МБ", done>>20, total>>20)
				if total <= 0 {
					d = fmt.Sprintf("%d МБ", done>>20)
				}
				set(func(s *State) { s.Pct = 3 + 67*frac; s.Detail = d; s.Eta = eta })
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	if total > 0 && done != total {
		return errors.New("загрузка оборвалась")
	}
	return nil
}

func humanLeft(sec float64) string {
	switch {
	case sec < 5:
		return "осталось несколько секунд"
	case sec < 60:
		return fmt.Sprintf("осталось около %d секунд", int(sec/5+1)*5)
	default:
		m := int(sec/60 + 0.5)
		return fmt.Sprintf("осталось около %d мин", m)
	}
}

func unzipTo(ctx context.Context, zr *zip.Reader, dir string, prog func(float64)) error {
	var total, done int64
	for _, f := range zr.File {
		total += int64(f.UncompressedSize64)
	}
	root := filepath.Clean(dir) + string(os.PathSeparator)
	for i, f := range zr.File {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		target := filepath.Join(dir, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(target, root) {
			continue
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(target, 0o755)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(target)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		rc.Close()
		out.Close()
		if err != nil {
			return err
		}
		done += int64(f.UncompressedSize64)
		if total > 0 && i%4 == 0 {
			prog(float64(done) / float64(total))
		}
	}
	prog(1)
	return nil
}

func copyFile(a, b string) error {
	in, err := os.Open(a)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(b)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func dirSizeKB(dir string) int {
	var n int64
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if fi, e := d.Info(); e == nil {
				n += fi.Size()
			}
		}
		return nil
	})
	return int(n >> 10)
}

// ---------- окно: локальный сервер для страницы установщика ----------
func token() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func serve(tok string) (string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	mux := http.NewServeMux()
	page := strings.ReplaceAll(uiHTML, "%%TOKEN%%", tok)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		io.WriteString(w, page)
	})
	api := func(path string, h func(w http.ResponseWriter, r *http.Request)) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-Pulse") != tok && r.URL.Query().Get("t") != tok {
				http.Error(w, "нет доступа", 403)
				return
			}
			mu.Lock()
			lastSeen = time.Now()
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			h(w, r)
		})
	}
	js := func(w http.ResponseWriter, v any) { json.NewEncoder(w).Encode(v) }
	api("/api/info", func(w http.ResponseWriter, r *http.Request) {
		d := defaultDir()
		_, statErr := os.Stat(filepath.Join(d, "pulse-install.json"))
		js(w, map[string]any{"dir": d, "freeMB": diskFreeMB(d), "needMB": needMB, "version": AppVersion, "arch": winArch(), "name": AppName, "installed": statErr == nil, "embedded": winArch() == "x64" && len(electronX64) > 0})
	})
	api("/api/free", func(w http.ResponseWriter, r *http.Request) {
		js(w, map[string]any{"freeMB": diskFreeMB(r.URL.Query().Get("dir"))})
	})
	api("/api/pickdir", func(w http.ResponseWriter, r *http.Request) {
		p, err := pickDir(r.URL.Query().Get("dir"))
		if err != nil {
			js(w, map[string]any{"dir": "", "err": err.Error()})
			return
		}
		// выбрали, например, D:\Программы — ставим в D:\Программы\Pulse, чтобы не смешивать с чужими файлами
		if p != "" && !strings.EqualFold(filepath.Base(p), "Pulse") {
			p = filepath.Join(p, "Pulse")
		}
		js(w, map[string]any{"dir": p, "freeMB": diskFreeMB(p)})
	})
	api("/api/install", func(w http.ResponseWriter, r *http.Request) {
		var o Opts
		if err := json.NewDecoder(r.Body).Decode(&o); err != nil || o.Dir == "" {
			o = Opts{Dir: defaultDir(), Desktop: true, StartMenu: true}
		}
		mu.Lock()
		busy := st.Phase == "installing"
		mu.Unlock()
		if !busy {
			ctx, cancel := context.WithCancel(context.Background())
			mu.Lock()
			cancelFn = cancel
			mu.Unlock()
			go func() {
				err := runInstall(ctx, o)
				if err != nil {
					if ctx.Err() != nil {
						set(func(s *State) { s.Phase = "cancelled"; s.Err = "" })
					} else {
						set(func(s *State) { s.Phase = "error"; s.Err = err.Error() })
					}
				}
			}()
		}
		js(w, get())
	})
	api("/api/state", func(w http.ResponseWriter, r *http.Request) { js(w, get()) })
	api("/api/cancel", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if cancelFn != nil {
			cancelFn()
		}
		mu.Unlock()
		js(w, get())
	})
	api("/api/launch", func(w http.ResponseWriter, r *http.Request) {
		s := get()
		killApp(s.Dir) // вдруг осталась зависшая копия — она не дала бы открыть окно
		err := launchApp(filepath.Join(s.Dir, ExeName), s.Dir)
		js(w, map[string]any{"ok": err == nil})
		if err == nil {
			go func() { time.Sleep(400 * time.Millisecond); quitCh <- struct{}{} }()
		}
	})
	api("/api/quit", func(w http.ResponseWriter, r *http.Request) {
		js(w, map[string]any{"ok": true})
		go func() { time.Sleep(200 * time.Millisecond); quitCh <- struct{}{} }()
	})
	go http.Serve(ln, mux)
	return "http://" + ln.Addr().String() + "/", nil
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--uninstall" {
		uninstall()
		return
	}
	if msg := osCheck(); msg != "" {
		fatal(msg)
		return
	}
	if !singleInstance() {
		return
	}
	tok := token()
	url, err := serve(tok)
	if err != nil {
		fatal("Не получилось запустить установщик: " + err.Error())
		return
	}
	stop := openWindow(url) // Edge в режиме приложения; возвращает функцию «закрыть окно»
	if os.Getenv("PULSE_SETUP_PRINT_URL") == "1" {
		fmt.Println(url + "?t=" + tok)
	}
	// ждём: «Закрыть» / «Запустить Пульс», закрытое окно или тишину от окна (окно закрыли, а Edge не завершился)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-quitCh:
			waitInstall()
			stop()
			return
		case <-windowClosed:
			waitInstall()
			stop()
			return
		case <-tick.C:
			mu.Lock()
			idle := time.Since(lastSeen) > 25*time.Second && st.Phase != "installing"
			mu.Unlock()
			if idle && os.Getenv("PULSE_SETUP_PRINT_URL") != "1" {
				stop()
				return
			}
		}
	}
}

// окно закрыли посреди установки — доустанавливаем молча, ярлык всё равно появится
func waitInstall() {
	for get().Phase == "installing" {
		time.Sleep(300 * time.Millisecond)
	}
}

var windowClosed = make(chan struct{})
