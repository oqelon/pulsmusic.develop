// Проверка на Mac (CI): какие форматы разжимает и играет WebKit — тот же движок, что окно «Пульса» на Mac.
// Нужна для форматов, которые звуковой движок отдаёт окну (Opus, WebM): воспроизведение и «Записать CD / В WAV».
//   swift tools/webkit-formats.swift <папка с файлами> <файл>...
import Cocoa
import WebKit

let args = CommandLine.arguments
let dir = args[1]
let files = Array(args.dropFirst(2))
let app = NSApplication.shared
let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 100, height: 100), configuration: WKWebViewConfiguration())
final class Nav: NSObject, WKNavigationDelegate {
    var done: (() -> Void)?
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { done?(); done = nil }
}
let nav = Nav()
wv.navigationDelegate = nav
DispatchQueue.main.asyncAfter(deadline: .now() + 120) { print("время вышло"); exit(2) }
nav.done = {
    Task { @MainActor in
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        print("macOS \(os)")
        let types = ["audio/ogg; codecs=opus", "audio/webm; codecs=opus", "audio/webm; codecs=vorbis", "audio/ogg; codecs=vorbis", "audio/mp4; codecs=alac", "audio/flac", "audio/x-wavpack"]
        for t in types {
            let r = try? await wv.callAsyncJavaScript("return new Audio().canPlayType(t) || 'нет'", arguments: ["t": t], contentWorld: .page)
            print("canPlayType \(t): \(r ?? "?")")
        }
        for f in files {
            guard let data = FileManager.default.contents(atPath: dir + "/" + f) else { print("\(f): нет файла"); continue }
            let js = """
            const b = Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
            try { const a = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(b); return 'разжал: ' + a.duration.toFixed(2) + ' с'; }
            catch (e) { return 'НЕ разжал: ' + e; }
            """
            let r = try? await wv.callAsyncJavaScript(js, arguments: ["s": data.base64EncodedString()], contentWorld: .page)
            print("\(f): \(r ?? "нет ответа")")
        }
        exit(0)
    }
}
wv.loadHTMLString("<!doctype html><title>x</title>", baseURL: URL(string: "https://localhost/"))
app.run()
