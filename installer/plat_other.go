//go:build !windows

// Заглушки для проверки установщика не на Windows (окно и логика установки те же, без ярлыков и реестра).
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func fatal(msg string)               { fmt.Fprintln(os.Stderr, msg) }
func singleInstance() bool           { return true }
func winArch() string                { return "x64" }
func killApp(dir string)             {}
func osCheck() string                { return "" }
func hideProc(c *exec.Cmd)           {}
func pickDir(string) (string, error) { return "", nil }
func launchApp(exe, dir string) error {
	fmt.Println("launch", exe)
	return nil
}
func diskFreeMB(dir string) int {
	var s syscall.Statfs_t
	d := dir
	for {
		if syscall.Statfs(d, &s) == nil {
			return int(uint64(s.Bavail) * uint64(s.Bsize) >> 20)
		}
		p := filepath.Dir(d)
		if p == d {
			return 0
		}
		d = p
	}
}
func makeShortcuts(exe, dir, ico string, o Opts) error {
	return os.WriteFile(filepath.Join(dir, "SHORTCUT-"+AppName+".txt"), []byte(exe), 0o644)
}
func registerUninstall(dir, exe, ico, uninst string, kb int) {}
func openWindow(url string) func()                           { fmt.Println("open", url); return func() {} }
func uninstall()                                             {}
