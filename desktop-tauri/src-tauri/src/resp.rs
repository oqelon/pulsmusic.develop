// Общее для своих схем (pulseya://, pulsefile://, pulsetest://): разбор Range, ответы, адрес.

use tauri::http::{header, Response, StatusCode};

/// Запрошенный кусок, как его прислал плеер (длина файла может быть ещё неизвестна).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Want {
    /// «bytes=a-b» или «bytes=a-»
    From(u64, Option<u64>),
    /// «bytes=-n» — последние n байт
    Suffix(u64),
}

pub fn parse_want(v: &str) -> Option<Want> {
    let r = v.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = r.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        return if n == 0 { None } else { Some(Want::Suffix(n)) };
    }
    let s: u64 = a.parse().ok()?;
    let e: Option<u64> = if b.is_empty() { None } else { Some(b.parse().ok()?) };
    if let Some(e) = e { if e < s { return None; } }
    Some(Want::From(s, e))
}

/// Кусок для файла известной длины → (начало, конец включительно). None — кусок за пределами файла.
pub fn resolve(w: Want, len: u64) -> Option<(u64, u64)> {
    if len == 0 { return None; }
    match w {
        Want::From(s, e) => {
            if s >= len { return None; }
            Some((s, e.unwrap_or(len - 1).min(len - 1)))
        }
        Want::Suffix(n) => Some((len.saturating_sub(n), len - 1)),
    }
}

pub fn plain(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-store")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

pub fn not_satisfiable(total: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_RANGE, format!("bytes */{total}"))
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .unwrap()
}

/// Ответ с куском звука. `range` — Some((начало, итого)) для 206, None — весь файл (200).
pub fn media(ct: &str, body: Vec<u8>, range: Option<(u64, String)>, cache: &str) -> Response<Vec<u8>> {
    let n = body.len() as u64;
    let mut b = Response::builder()
        .status(if range.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::CONTENT_TYPE, ct)
        .header(header::CONTENT_LENGTH, n.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Content-Length, Accept-Ranges")
        .header(header::CACHE_CONTROL, cache);
    if let Some((start, total)) = range {
        let end = if n == 0 { start } else { start + n - 1 };
        b = b.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"));
    }
    b.body(body).unwrap()
}

/// Адрес своей схемы → (раздел, остальное).
/// macOS/Linux: «pulseya://s/<id>» → ("s", "<id>"). Windows (WebView2): «http://pulseya.localhost/s/<id>» → то же.
pub fn split_uri(uri: &tauri::http::Uri) -> (String, String) {
    let host = uri.host().unwrap_or("").to_ascii_lowercase();
    let path = uri.path().trim_start_matches('/');
    if host.is_empty() || host.ends_with(".localhost") || host == "localhost" {
        let (h, rest) = path.split_once('/').unwrap_or((path, ""));
        return (h.to_string(), rest.to_string());
    }
    (host, path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn want() {
        assert_eq!(parse_want("bytes=0-"), Some(Want::From(0, None)));
        assert_eq!(parse_want("bytes=0-1"), Some(Want::From(0, Some(1))));
        assert_eq!(parse_want("bytes=100-199, 300-"), Some(Want::From(100, Some(199))));
        assert_eq!(parse_want("bytes=-500"), Some(Want::Suffix(500)));
        assert_eq!(parse_want("bytes=5-1"), None);
        assert_eq!(parse_want("items=0-1"), None);
        assert_eq!(parse_want("bytes=-0"), None);
        assert_eq!(resolve(Want::From(0, None), 10), Some((0, 9)));
        assert_eq!(resolve(Want::From(3, Some(100)), 10), Some((3, 9)));
        assert_eq!(resolve(Want::From(10, None), 10), None);
        assert_eq!(resolve(Want::Suffix(4), 10), Some((6, 9)));
        assert_eq!(resolve(Want::Suffix(40), 10), Some((0, 9)));
    }
    #[test]
    fn uri() {
        let u: tauri::http::Uri = "pulseya://s/abc".parse().unwrap();
        assert_eq!(split_uri(&u), ("s".into(), "abc".into()));
        let u: tauri::http::Uri = "http://pulseya.localhost/s/abc".parse().unwrap();
        assert_eq!(split_uri(&u), ("s".into(), "abc".into()));
        let u: tauri::http::Uri = "pulsefile://a/k1".parse().unwrap();
        assert_eq!(split_uri(&u), ("a".into(), "k1".into()));
    }
}
