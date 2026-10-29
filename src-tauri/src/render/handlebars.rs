use super::barcode;
use anyhow::Result;
use handlebars::Handlebars;

pub struct TemplateEngine {
    hb: Handlebars<'static>,
}

impl TemplateEngine {
    pub fn new() -> Self {
        let mut hb = Handlebars::new();
        Self::register_helpers(&mut hb);
        Self { hb }
    }

    fn register_helpers(hb: &mut Handlebars<'static>) {
        hb.register_helper("currency", Box::new(currency_helper));
        hb.register_helper("date", Box::new(date_helper));
        hb.register_helper("upper", Box::new(upper_helper));
        hb.register_helper("lower", Box::new(lower_helper));
        hb.register_helper("padLeft", Box::new(pad_left_helper));
        hb.register_helper("number", Box::new(number_helper));
        hb.register_helper("barcode", Box::new(barcode_helper));
        hb.register_helper("qrcode", Box::new(qrcode_helper));
    }

    pub fn render(&self, template: &str, data: &serde_json::Value) -> Result<String> {
        let out = self
            .hb
            .render_template(template, data)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(sanitize_html(&out))
    }
}

impl Default for TemplateEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Strip <script> tags and event-handler attributes (V2.md §8.3).
/// Used on every render so a compromised server row cannot execute.
/// Remote auto-load references go through [`strip_remote_fetches`] right
/// after, so one call is the whole print-time guarantee: no code, no
/// network.
pub fn sanitize_html(input: &str) -> String {
    strip_remote_fetches(&do_strip_scripts_and_handlers(input))
}

/// Script/handler/javascript: stripping (no remote-URL handling here —
/// that is [`strip_remote_fetches`], kept separate so each pass stays
/// reviewable).
/// Strip remote auto-load references so printing never touches the
/// network: remote `src`/`srcset`/poster/object-data/background
/// attributes are dropped (plain `<a href>` stays — links don't fetch),
/// remote `url()` targets are blanked, and remote `@import` rules are
/// dropped. `data:` and relative URLs stay.
///
/// Mirrors the frontend `stripScriptsAndHandlers` contract (same tag and
/// attribute sets, including stylesheet `<link>`), so preview and print
/// agree on what loads. Save-time validation rejects remote refs in
/// stored templates; this pass covers what save never saw — record data
/// rendered through `{{{triple-stash}}}`, legacy rows, and the manual
/// `peer_render_request` command.
///
/// Best-effort textual scan in this module's existing style, not a DOM
/// parse: `<!-- -->` comments pass through byte-identical and a stray
/// `<` in text is left alone. The save-time DOM-based check is the
/// security boundary; this is the no-fetch guarantee. As a side effect
/// it is also a speed fix: a hanging remote image no longer stalls the
/// renderer inside the print path.
fn strip_remote_fetches(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    // Open-tag name while inside `<…>`, lowercased; None in text.
    let mut tag: Option<String> = None;
    let mut squote = false;
    let mut dquote = false;

    // Case-insensitive `<!--` at i, else None.
    let comment_at = |i: usize| -> bool {
        i + 3 < chars.len()
            && chars[i] == '<'
            && chars[i + 1] == '!'
            && chars[i + 2] == '-'
            && chars[i + 3] == '-'
    };
    // Case-insensitive `</style` at i (caller is past `<style…>`; the raw
    // text runs until here even if it contains `<` or quotes).
    let style_end_at = |i: usize| -> bool {
        i + 6 < chars.len()
            && chars[i] == '<'
            && chars[i + 1] == '/'
            && chars[i + 2].eq_ignore_ascii_case(&'s')
            && chars[i + 3].eq_ignore_ascii_case(&'t')
            && chars[i + 4].eq_ignore_ascii_case(&'y')
            && chars[i + 5].eq_ignore_ascii_case(&'l')
            && chars[i + 6].eq_ignore_ascii_case(&'e')
    };

    while i < chars.len() {
        let c = chars[i];
        if tag.is_none() {
            if comment_at(i) {
                // Copy the comment through untouched: an @import inside a
                // comment is inert, and rewriting comment text can only
                // corrupt the author's notes.
                let mut j = i + 4;
                while j + 2 < chars.len()
                    && !(chars[j] == '-' && chars[j + 1] == '-' && chars[j + 2] == '>')
                {
                    j += 1;
                }
                let end = (j + 3).min(chars.len());
                out.extend(&chars[i..end]);
                i = end;
                continue;
            }
            if c == '<' {
                if i + 1 < chars.len() && chars[i + 1] == '/' {
                    out.push('<');
                    out.push('/');
                    i += 2;
                    continue;
                }
                if i + 1 < chars.len() && chars[i + 1].is_ascii_alphabetic() {
                    // Open tag: copy `<name`, track it for attribute rules.
                    let mut j = i + 1;
                    while j < chars.len() && chars[j].is_ascii_alphanumeric() {
                        j += 1;
                    }
                    let name: String = chars[i + 1..j]
                        .iter()
                        .collect::<String>()
                        .to_ascii_lowercase();
                    // A refresh meta navigates away: drop the whole element
                    // (mirrors the frontend).
                    if name == "meta" && meta_refreshes(&chars, j) {
                        while j < chars.len() && chars[j] != '>' {
                            j += 1;
                        }
                        i = (j + 1).min(chars.len());
                        continue;
                    }
                    out.push('<');
                    out.extend(&chars[i + 1..j]);
                    i = j;
                    tag = Some(name);
                    squote = false;
                    dquote = false;
                    continue;
                }
            }
            out.push(c);
            i += 1;
            continue;
        }
        // Inside `<…>`: quotes protect `>` in values.
        if squote {
            out.push(c);
            if c == '\'' {
                squote = false;
            }
            i += 1;
            continue;
        }
        if dquote {
            out.push(c);
            if c == '"' {
                dquote = false;
            }
            i += 1;
            continue;
        }
        if c == '\'' {
            squote = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '"' {
            dquote = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '>' {
            out.push(c);
            i += 1;
            if tag.as_deref() == Some("style") {
                // Raw-text element: scrub the CSS up to `</style`, then
                // resume normal scanning at the closing tag.
                let mut j = i;
                while j < chars.len() && !style_end_at(j) {
                    j += 1;
                }
                let css: String = chars[i..j].iter().collect();
                out.push_str(&scrub_css_block(&css));
                i = j;
            }
            tag = None;
            continue;
        }
        if c.is_whitespace() {
            // Look ahead: attribute, or just spacing before `>`/`/`?
            let mut j = i;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j >= chars.len() || chars[j] == '>' || chars[j] == '/' {
                out.extend(&chars[i..j]);
                i = j;
                continue;
            }
            // Attribute name.
            let mut k = j;
            while k < chars.len()
                && (chars[k].is_ascii_alphanumeric() || matches!(chars[k], '-' | '_' | ':' | '.'))
            {
                k += 1;
            }
            if k == j {
                out.push(c);
                i += 1;
                continue;
            }
            let attr: String = chars[j..k].iter().collect::<String>().to_ascii_lowercase();
            let mut l = k;
            while l < chars.len() && chars[l].is_whitespace() {
                l += 1;
            }
            // Boolean attribute: keep verbatim.
            if l >= chars.len() || chars[l] != '=' {
                out.extend(&chars[i..k]);
                i = k;
                continue;
            }
            l += 1;
            while l < chars.len() && chars[l].is_whitespace() {
                l += 1;
            }
            // Value span [v, m): quoted, unquoted (to whitespace or `>`),
            // or empty at the tag end.
            let (v, m) = if l < chars.len() && (chars[l] == '"' || chars[l] == '\'') {
                let q = chars[l];
                let mut m = l + 1;
                while m < chars.len() && chars[m] != q {
                    m += 1;
                }
                (l, (m + 1).min(chars.len()))
            } else {
                let mut m = l;
                while m < chars.len() && !chars[m].is_whitespace() && chars[m] != '>' {
                    m += 1;
                }
                (l, m)
            };
            let current = tag.clone().unwrap_or_default();
            match decide_attr(&current, &attr, &chars[v..m]) {
                AttrDecision::Keep => {
                    out.extend(&chars[i..m]);
                }
                AttrDecision::Drop => {}
                AttrDecision::Rewrite(replacement) => {
                    out.extend(&chars[i..v]);
                    // Preserve the original quoting: the span starts at the
                    // opening quote for quoted values, at the value itself
                    // for unquoted ones.
                    if v < chars.len() && (chars[v] == '"' || chars[v] == '\'') {
                        out.push(chars[v]);
                        out.push_str(&replacement);
                        // Re-add the closing quote when the value had one
                        // (unterminated values at the tag end have none).
                        if m - v > 1 && chars[m - 1] == chars[v] {
                            out.push(chars[v]);
                        }
                    } else {
                        out.push_str(&replacement);
                    }
                }
            }
            i = m;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// What to do with one scanned attribute in [`strip_remote_fetches`].
enum AttrDecision {
    Keep,
    Drop,
    /// Replace the (unquoted) value, keeping the original quotes.
    Rewrite(String),
}

/// `true` for `http://`, `https://` (any case) and protocol-relative
/// `//` — the values a renderer would fetch over the network. Mirrors
/// the frontend `isRemoteUrl`; `data:` never matches.
fn is_remote_url(value: &[char]) -> bool {
    let s: String = value.iter().collect();
    let lower = s.trim_start().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("//")
}

/// Attribute value without surrounding quotes (kept as-is when the
/// quotes are unbalanced).
fn strip_quotes(value: &[char]) -> &[char] {
    if value.len() >= 2
        && (value[0] == '"' || value[0] == '\'')
        && value[value.len() - 1] == value[0]
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

/// Auto-fetched attributes per tag, mirroring the frontend
/// `AUTO_LOAD_TAGS` (plus stylesheet `<link>`, which the frontend
/// reports but the print path must also not fetch).
fn autoload_attrs(tag: &str) -> &'static [&'static str] {
    match tag {
        "img" => &["src", "srcset"],
        "source" => &["src", "srcset"],
        "video" => &["src", "poster"],
        "audio" | "track" | "input" | "embed" | "iframe" => &["src"],
        "object" => &["data"],
        "body" | "table" | "td" | "th" => &["background"],
        "link" => &["href"],
        _ => &[],
    }
}

fn decide_attr(tag: &str, attr: &str, value: &[char]) -> AttrDecision {
    // A base href hijacks every relative URL in the document.
    if tag == "base" && attr == "href" {
        return AttrDecision::Drop;
    }
    if attr == "style" {
        let css: String = strip_quotes(value).iter().collect();
        return match scrub_css_urls(&css) {
            None => AttrDecision::Drop,
            Some(cleaned) => {
                let current: String = strip_quotes(value).iter().collect();
                if cleaned == current {
                    AttrDecision::Keep
                } else {
                    AttrDecision::Rewrite(cleaned)
                }
            }
        };
    }
    if !autoload_attrs(tag).contains(&attr) {
        return AttrDecision::Keep;
    }
    if attr == "srcset" {
        // Filter per candidate but keep each survivor verbatim —
        // descriptors (`1x`, `100w`) decide which image loads, so
        // dropping them would break responsive images.
        let inner: String = strip_quotes(value).iter().collect();
        let kept: Vec<String> = inner
            .split(',')
            .map(str::trim)
            .filter(|part| {
                let url = part.split_whitespace().next().unwrap_or("");
                !url.is_empty() && !is_remote_url(&url.chars().collect::<Vec<_>>())
            })
            .map(str::to_string)
            .collect();
        if kept.is_empty() {
            return AttrDecision::Drop;
        }
        let joined = kept.join(", ");
        if joined == inner {
            AttrDecision::Keep
        } else {
            AttrDecision::Rewrite(joined)
        }
    } else if is_remote_url(strip_quotes(value)) {
        AttrDecision::Drop
    } else {
        AttrDecision::Keep
    }
}

/// `true` when the `<meta…>` tag ending at the next `>` carries
/// `http-equiv` refresh (any quoting, any case). The whole element is
/// dropped by the caller.
fn meta_refreshes(chars: &[char], from: usize) -> bool {
    let mut k = from;
    while k < chars.len() && chars[k] != '>' {
        k += 1;
    }
    let span: String = chars[from..k].iter().collect();
    let lower = span.to_ascii_lowercase();
    let Some(pos) = lower.find("http-equiv") else {
        return false;
    };
    let rest = &lower[pos + "http-equiv".len()..];
    let Some(eq) = rest.find('=') else {
        return false;
    };
    // Value token: quoted (to the matching quote) or bare (to whitespace
    // or `>`). The content attribute often carries more after it
    // (`content="0;url=…"`) — only the first token counts.
    let mut value = rest[eq + 1..].trim_start();
    if value.starts_with('"') || value.starts_with('\'') {
        let q = value.chars().next().unwrap_or('"');
        value = &value[q.len_utf8()..];
        let end = value.find(q).unwrap_or(value.len());
        value = &value[..end];
    } else {
        let end = value
            .find(|c: char| c.is_whitespace() || c == '>')
            .unwrap_or(value.len());
        value = &value[..end];
    }
    value == "refresh"
}

/// Scrub a CSS declaration block or stylesheet: drop remote `@import`
/// rules (they fetch on parse) and blank remote `url()` targets.
/// Returns `None` when the whole block is a lone `javascript:` payload
/// (the attribute is dropped then). Mirrors the frontend scrubbers.
fn scrub_css_urls(css: &str) -> Option<String> {
    let trimmed = css.trim_start();
    if let Some(after) = trimmed
        .get(.."javascript".len())
        .filter(|head| head.eq_ignore_ascii_case("javascript"))
        .map(|_| &trimmed["javascript".len()..])
    {
        if after.trim_start().starts_with(':') {
            return None;
        }
    }
    let chars: Vec<char> = css.chars().collect();
    let mut out = String::with_capacity(css.len());
    let mut i = 0;
    while i < chars.len() {
        // `@import` rule: `url(…)` form, quoted form, then optional `;`.
        if starts_word_ignore_case(&chars, i, "@import")
            && (i == 0 || !is_css_name_char(chars[i - 1]))
        {
            let mut j = i + "@import".len();
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if starts_word_ignore_case(&chars, j, "url") {
                j += 3;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if j < chars.len() && chars[j] == '(' {
                    j = close_paren(&chars, j);
                }
            } else if j < chars.len() && (chars[j] == '"' || chars[j] == '\'') {
                let q = chars[j];
                j += 1;
                while j < chars.len() && chars[j] != q {
                    j += 1;
                }
                j = (j + 1).min(chars.len());
            } else {
                // Bare `@import` with no URL (invalid CSS): keep verbatim.
                out.extend(&chars[i..j]);
                i = j;
                continue;
            }
            let mut end = j;
            while end < chars.len() && chars[end].is_whitespace() {
                end += 1;
            }
            if end < chars.len() && chars[end] == ';' {
                end += 1;
            }
            let rule: String = chars[i..end].iter().collect();
            let rule_lower = rule.to_ascii_lowercase();
            if rule_lower.contains("https://")
                || rule_lower.contains("http://")
                || rule_lower.contains("//")
            {
                // Remote import: drop the rule, keep nothing.
            } else {
                out.push_str(&rule);
            }
            i = end;
            continue;
        }
        // `url(…)` target.
        if starts_word_ignore_case(&chars, i, "url") && (i == 0 || !is_css_name_char(chars[i - 1]))
        {
            let mut j = i + 3;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && chars[j] == '(' {
                let end = close_paren(&chars, j);
                let inner: String = chars[j + 1..end.saturating_sub(1)].iter().collect();
                let target = inner.trim().trim_matches('"').trim_matches('\'').trim();
                let blank = is_javascript_url(target)
                    || (is_remote_url(&target.chars().collect::<Vec<_>>())
                        && !target
                            .trim_start()
                            .to_ascii_lowercase()
                            .starts_with("data:"));
                out.push_str("url(");
                if !blank {
                    out.extend(&chars[j + 1..end.saturating_sub(1)]);
                }
                out.push(')');
                i = end;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    Some(out)
}

fn scrub_css_block(css: &str) -> String {
    scrub_css_urls(css).unwrap_or_default()
}

fn starts_word_ignore_case(chars: &[char], at: usize, word: &str) -> bool {
    let w: Vec<char> = word.chars().collect();
    if at + w.len() > chars.len() {
        return false;
    }
    chars[at..at + w.len()]
        .iter()
        .zip(w.iter())
        .all(|(a, b)| a.eq_ignore_ascii_case(b))
}

fn is_css_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '\\')
}

/// Index just past the `)` matching the `(` at `open` (or the input
/// length when unbalanced).
fn close_paren(chars: &[char], open: usize) -> usize {
    let mut depth = 0usize;
    let mut j = open;
    let mut quote: Option<char> = None;
    while j < chars.len() {
        let c = chars[j];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
        } else if c == '"' || c == '\'' {
            quote = Some(c);
        } else if c == '(' {
            depth += 1;
        } else if c == ')' {
            depth -= 1;
            if depth == 0 {
                return j + 1;
            }
        }
        j += 1;
    }
    chars.len()
}

/// `true` for a `javascript:` payload (any case, optional space before
/// the colon), mirroring the frontend check.
fn is_javascript_url(target: &str) -> bool {
    let lower = target.trim_start().to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("javascript") {
        return rest.trim_start().starts_with(':');
    }
    false
}

/// Script/handler/javascript: stripping (no remote-URL handling here —
/// that is [`strip_remote_fetches`], kept separate so each pass stays
/// reviewable).
fn do_strip_scripts_and_handlers(input: &str) -> String {
    let mut out = input.to_string();

    // Strip <script ...>...</script> case-insensitive
    loop {
        let lower = out.to_lowercase();
        if let Some(start) = lower.find("<script") {
            if let Some(end) = lower[start..].find("</script>") {
                let end_idx = start + end + "</script>".len();
                out.replace_range(start..end_idx, "");
                continue;
            } else if let Some(tag_end) = lower[start..].find('>') {
                let end_idx = start + tag_end + 1;
                out.replace_range(start..end_idx, "");
                continue;
            } else {
                out.replace_range(start.., "");
                break;
            }
        }
        break;
    }
    // Self-closing script tags
    loop {
        let lower = out.to_lowercase();
        if let Some(start) = lower.find("<script") {
            if let Some(end) = lower[start..].find('>') {
                out.replace_range(start..start + end + 1, "");
                continue;
            }
            break;
        }
        break;
    }

    // Strip on* handler attributes:  onxxx="..."  onxxx='...'  onxxx=unquoted
    // UTF-8 safe: iterate over chars, not bytes.
    let chars: Vec<char> = out.chars().collect();
    let mut result = String::with_capacity(out.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j + 2 < chars.len()
                && (chars[j] == 'o' || chars[j] == 'O')
                && (chars[j + 1] == 'n' || chars[j + 1] == 'N')
            {
                let mut k = j + 2;
                while k < chars.len() && chars[k].is_alphanumeric() {
                    k += 1;
                }
                let mut l = k;
                while l < chars.len() && chars[l].is_whitespace() {
                    l += 1;
                }
                if l < chars.len() && chars[l] == '=' {
                    l += 1;
                    while l < chars.len() && chars[l].is_whitespace() {
                        l += 1;
                    }
                    if l < chars.len() {
                        if chars[l] == '"' || chars[l] == '\'' {
                            let quote = chars[l];
                            l += 1;
                            while l < chars.len() && chars[l] != quote {
                                l += 1;
                            }
                            if l < chars.len() {
                                l += 1;
                            }
                        } else {
                            while l < chars.len() && !chars[l].is_whitespace() && chars[l] != '>' {
                                l += 1;
                            }
                        }
                    }
                    i = l;
                    continue;
                }
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    out = result;

    // Strip javascript: URLs
    let mut cleaned = out;
    for pat in ["javascript:", "JAVASCRIPT:", "Javascript:"] {
        cleaned = cleaned.replace(pat, "");
    }
    // Also handle href/src with javascript: inside quotes — already stripped above generically,
    // but this catches remaining.
    cleaned
}

/// Detect remote references that should be rejected on publish (V2.md §8.3).
/// Returns Some(messages) if found, None if clean.
pub fn find_remote_refs(html: &str, css: &str) -> Option<Vec<String>> {
    let mut issues = Vec::new();
    let lower_html = html.to_lowercase();
    let lower_css = css.to_lowercase();

    for needle in [
        "src=\"http",
        "src='http",
        "href=\"http",
        "href='http",
        "src=\"//",
        "href=\"//",
    ] {
        if lower_html.contains(needle) {
            // The needle itself is the snippet (7-10 chars by
            // construction): never slice it. `&needle[..20]` stood here
            // and panicked on every hit — inside Tauri's WebView2 COM
            // callback that panic cannot unwind, so the whole app died
            // instead of reporting a validation error.
            issues.push(format!(
                "Remote reference in HTML: {} — use data: URIs",
                needle
            ));
        }
    }
    for needle in [
        "url(\"http",
        "url('http",
        "url(http",
        "url(\"//",
        "url('//",
        "url(//",
    ] {
        if lower_html.contains(needle) || lower_css.contains(needle) {
            issues.push(format!(
                "Remote url() in CSS/HTML: {} — use data: URIs",
                needle
            ));
        }
    }
    if lower_html.contains("@import")
        && (lower_html.contains("http://")
            || lower_html.contains("https://")
            || lower_html.contains("//"))
    {
        issues.push("@import with remote URL — use data: URIs".to_string());
    }

    if issues.is_empty() {
        None
    } else {
        Some(issues)
    }
}

fn currency_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let value = h.param(0).and_then(|v| v.value().as_f64()).unwrap_or(0.0);
    let symbol = h.param(1).and_then(|v| v.value().as_str()).unwrap_or("$");
    out.write(&format!("{}{:.2}", symbol, value))?;
    Ok(())
}

fn date_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let value = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
    if value.is_empty() {
        return Ok(());
    }

    // Parse ISO-8601 / RFC-3339 first, then fall back to the raw string so a
    // non-date value is never silently mangled. (The previous version just
    // echoed `"<value> (<format>)"`, which is not a date formatter at all.)
    let parsed = chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&chrono::Local))
        .ok();

    let Some(dt) = parsed else {
        out.write(value)?;
        return Ok(());
    };

    let format = h
        .param(1)
        .and_then(|v| v.value().as_str())
        .unwrap_or("%Y-%m-%d");
    let rendered = match format {
        "short" => dt.format("%d %b %Y").to_string(),
        "long" => dt.format("%d %B %Y, %H:%M").to_string(),
        "time" => dt.format("%H:%M").to_string(),
        "datetime" => dt.format("%Y-%m-%d %H:%M").to_string(),
        // Anything else is treated as a strftime pattern.
        other => dt.format(other).to_string(),
    };

    out.write(&rendered)?;
    Ok(())
}

fn upper_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let value = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
    out.write(&value.to_uppercase())?;
    Ok(())
}

fn lower_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let value = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
    out.write(&value.to_lowercase())?;
    Ok(())
}

fn pad_left_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let value = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
    let width = h.param(1).and_then(|v| v.value().as_u64()).unwrap_or(0) as usize;

    // The custom pad character was read but never used: `{:>width$}` always
    // pads with spaces. Honour it now.
    let pad_char = h
        .param(2)
        .and_then(|v| v.value().as_str())
        .and_then(|s| s.chars().next())
        .unwrap_or(' ');

    let current = value.chars().count();
    if current >= width {
        out.write(value)?;
        return Ok(());
    }

    let padding: String = std::iter::repeat_n(pad_char, width - current).collect();
    out.write(&padding)?;
    out.write(value)?;
    Ok(())
}

fn number_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let value = h.param(0).and_then(|v| v.value().as_f64()).unwrap_or(0.0);
    let decimals = h.param(1).and_then(|v| v.value().as_u64()).unwrap_or(0) as usize;
    out.write(&format!("{:.*}", decimals, value))?;
    Ok(())
}

/// A helper argument as text: strings as-is, numbers and booleans formatted,
/// anything else (missing, null, objects) as empty.
fn value_as_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

/// `{{barcode "code128" order.id}}`, optionally `width=50` (mm) and `text=false`.
fn barcode_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let kind = h
        .param(0)
        .map(|v| value_as_text(v.value()))
        .unwrap_or_default();
    let value = h
        .param(1)
        .map(|v| value_as_text(v.value()))
        .unwrap_or_default();
    let width = h
        .hash_get("width")
        .and_then(|v| v.value().as_f64())
        .unwrap_or(barcode::DEFAULT_BARCODE_WIDTH_MM);
    let show_text = hash_flag(h, "text", true);

    // An unencodable value prints nothing; it must not fail the whole job.
    if let Some(html) = barcode::barcode_html(&kind, &value, width, show_text) {
        out.write(&html)?;
    }
    Ok(())
}

/// `{{qrcode order.url}}`, optionally `size=30` (mm).
fn qrcode_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let value = h
        .param(0)
        .map(|v| value_as_text(v.value()))
        .unwrap_or_default();
    let size = h
        .hash_get("size")
        .and_then(|v| v.value().as_f64())
        .unwrap_or(barcode::DEFAULT_QR_SIZE_MM);

    if let Some(html) = barcode::qr_html(&value, size) {
        out.write(&html)?;
    }
    Ok(())
}

/// A boolean hash option: `false` / `"false"` / `0` turn it off.
fn hash_flag(h: &handlebars::Helper, name: &str, default: bool) -> bool {
    match h.hash_get(name).map(|v| v.value()) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => !s.eq_ignore_ascii_case("false"),
        Some(serde_json::Value::Number(n)) => n.as_f64() != Some(0.0),
        _ => default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn barcode_helper_reads_the_value_from_data() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "order": { "id": "ORD-1042" } });
        let out = engine
            .render("{{barcode \"code128\" order.id}}", &data)
            .unwrap();
        assert!(out.contains("<svg"));
        assert!(out.contains(">ORD-1042</text>"));
    }

    #[test]
    fn barcode_helper_accepts_numbers_and_hash_options() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "n": 1042 });
        let out = engine
            .render("{{barcode \"code128\" n width=60 text=false}}", &data)
            .unwrap();
        assert!(out.contains("width=\"60mm\""));
        assert!(!out.contains("<text"));
    }

    #[test]
    fn barcode_helper_prints_nothing_for_missing_or_invalid_values() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "bad": "123" });
        assert_eq!(
            engine
                .render("{{barcode \"code128\" nope}}", &data)
                .unwrap(),
            ""
        );
        // EAN-13 needs 13 digits.
        assert_eq!(
            engine.render("{{barcode \"ean13\" bad}}", &data).unwrap(),
            ""
        );
        assert_eq!(
            engine
                .render("{{barcode \"datamatrix\" bad}}", &data)
                .unwrap(),
            ""
        );
    }

    #[test]
    fn qrcode_helper_reads_the_value_from_data() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "url": "https://example.com/o/1" });
        let out = engine.render("{{qrcode url size=30}}", &data).unwrap();
        assert!(out.contains("width=\"30mm\" height=\"30mm\""));
    }

    #[test]
    fn barcode_survives_the_sanitizer() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "id": "A1" });
        let out = engine.render("{{barcode \"code39\" id}}", &data).unwrap();
        assert!(out.contains("<path d=\"M"));
        assert!(out.contains("<rect"));
    }

    #[test]
    fn remote_img_src_is_dropped_data_and_relative_stay() {
        assert_eq!(
            sanitize_html(r#"<img src="https://x.test/y.png">"#),
            "<img>"
        );
        assert_eq!(sanitize_html(r#"<img src="HTTP://x.test/y.png">"#), "<img>");
        assert_eq!(sanitize_html(r#"<img src="//x.test/y.png">"#), "<img>");
        // data: and relative URLs never fetch: byte-identical.
        for clean in [
            r#"<img src="data:image/png;base64,iVBOR">"#,
            r#"<img src="logo.png">"#,
            r#"<img src="/assets/logo.png">"#,
        ] {
            assert_eq!(sanitize_html(clean), clean, "{clean}");
        }
    }

    #[test]
    fn plain_links_stay_remote_stylesheet_links_go() {
        // A link is text, not a fetch — but a stylesheet link IS one.
        let link = r#"<a href="https://x.test/order/1">view</a>"#;
        assert_eq!(sanitize_html(link), link);
        assert_eq!(
            sanitize_html(r#"<link rel="stylesheet" href="https://x.test/a.css">"#),
            "<link rel=\"stylesheet\">"
        );
    }

    #[test]
    fn srcset_drops_remote_candidates_keeps_the_rest() {
        assert_eq!(
            sanitize_html(r#"<img srcset="a.png 1x, https://x.test/b.png 2x">"#),
            r#"<img srcset="a.png 1x">"#
        );
        assert_eq!(
            sanitize_html(r#"<img srcset="https://x.test/a.png 1x, https://x.test/b.png 2x">"#),
            "<img>"
        );
    }

    #[test]
    fn style_urls_are_blanked_imports_dropped() {
        assert_eq!(
            sanitize_html(r#"<p style="background: url(https://x.test/bg.png)">hi</p>"#),
            r#"<p style="background: url()">hi</p>"#
        );
        assert_eq!(
            sanitize_html("<style>@import url(https://x.test/a.css); p{color:red}</style>"),
            "<style> p{color:red}</style>"
        );
        // data: and relative url() stay verbatim.
        for clean in [
            "<style>p{background:url(data:image/png;base64,iVBOR)}</style>",
            "<style>p{background:url(logo.png)}</style>",
        ] {
            assert_eq!(sanitize_html(clean), clean, "{clean}");
        }
    }

    /// Every documented needle must report instead of panic: the
    /// `src=`/`href=` branch once sliced `&needle[..20]` on 7-10 byte
    /// needles, and inside Tauri's WebView2 COM callback that panic
    /// cannot unwind — the whole app died on save instead of showing
    /// the validation error.
    #[test]
    fn every_remote_needle_reports_without_panicking() {
        // src=/href= needles (HTML only).
        for needle in [
            r#"src="http"#,
            r#"src='http"#,
            r#"href="http"#,
            r#"href='http"#,
            r#"src="//"#,
            r#"href="//"#,
        ] {
            let html = format!("<img {needle}://x.test/y.png\">");
            let issues = find_remote_refs(&html, "");
            assert!(
                issues.is_some(),
                "{needle} must be reported, not panicked on"
            );
        }
        // url() needles (HTML and CSS).
        for needle in [
            r#"url("http"#,
            r#"url('http"#,
            "url(http",
            r#"url("//"#,
            r#"url('//"#,
            "url(//",
        ] {
            let html = format!("<p style=\"background: {needle}://x.test/bg.png)\">hi</p>");
            assert!(
                find_remote_refs(&html, "").is_some(),
                "{needle} in HTML must be reported"
            );
            let css = format!("p{{background:{needle}://x.test/bg.png)}}");
            assert!(
                find_remote_refs("", &css).is_some(),
                "{needle} in CSS must be reported"
            );
        }
        // Case-insensitivity: the user typed SRC="HTTP...".
        assert!(
            find_remote_refs(r#"<IMG SRC="HTTP://x.test/y.png">"#, "").is_some(),
            "uppercase remote src must be reported"
        );
        // Clean content still passes.
        assert_eq!(
            find_remote_refs(
                r#"<img src="data:image/png;base64,iVBOR"><a href="/order/1">x</a>"#,
                "p{background:url(logo.png)}"
            ),
            None
        );
    }

    #[test]
    fn base_hijack_and_refresh_meta_are_removed() {
        assert_eq!(sanitize_html(r#"<base href="https://x.test/">"#), "<base>");
        assert_eq!(
            sanitize_html(r#"<meta http-equiv="refresh" content="0;url=https://x.test/">"#),
            ""
        );
    }

    #[test]
    fn comments_pass_through_untouched() {
        let comment = "<!-- @import url(https://x.test/a.css) -->";
        assert_eq!(sanitize_html(comment), comment);
    }

    #[test]
    fn video_poster_and_object_data_are_dropped_when_remote() {
        assert_eq!(
            sanitize_html(r#"<video poster="https://x.test/p.png"></video>"#),
            "<video></video>"
        );
        assert_eq!(
            sanitize_html(r#"<object data="https://x.test/a.pdf"></object>"#),
            "<object></object>"
        );
    }

    #[test]
    fn scripts_and_handlers_are_still_stripped_first() {
        assert_eq!(
            sanitize_html(r#"<img src="x" onerror="alert(1)">"#),
            r#"<img src="x">"#
        );
        assert!(sanitize_html("<script>evil()</script>hi").contains("hi"));
        assert!(!sanitize_html("<script>evil()</script>hi").contains("script"));
    }

    #[test]
    fn test_currency_helper() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({"price": 19.99});
        let result = engine.render("{{currency price}}", &data).unwrap();
        assert_eq!(result, "$19.99");
    }

    #[test]
    fn test_upper_helper() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({"name": "hello"});
        let result = engine.render("{{upper name}}", &data).unwrap();
        assert_eq!(result, "HELLO");
    }

    #[test]
    fn test_loop() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({
            "items": [
                {"name": "Tea", "price": 3.5},
                {"name": "Coffee", "price": 4.0}
            ]
        });
        let template = "{{#each items}}{{name}}: {{currency price}}\n{{/each}}";
        let result = engine.render(template, &data).unwrap();
        assert!(result.contains("Tea: $3.50"));
        assert!(result.contains("Coffee: $4.00"));
    }

    #[test]
    fn pad_left_uses_custom_pad_character() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "n": "42" });
        // The old implementation always padded with spaces.
        let out = engine.render("{{padLeft n 5 \"0\"}}", &data).unwrap();
        assert_eq!(out, "00042");
    }

    #[test]
    fn pad_left_defaults_to_spaces() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "n": "42" });
        let out = engine.render("{{padLeft n 5}}", &data).unwrap();
        assert_eq!(out, "   42");
    }

    #[test]
    fn pad_left_does_not_truncate_when_already_wide() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "n": "abcdef" });
        let out = engine.render("{{padLeft n 3}}", &data).unwrap();
        assert_eq!(out, "abcdef");
    }

    #[test]
    fn date_formats_iso_timestamp() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "d": "2026-10-17T12:30:00Z" });
        let out = engine.render("{{date d \"short\"}}", &data).unwrap();
        assert_eq!(out, "17 Oct 2026");

        let out = engine.render("{{date d \"time\"}}", &data).unwrap();
        assert!(out.contains(':'));
    }

    #[test]
    fn date_passes_through_unparseable_values() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "d": "not-a-date" });
        // Must not produce "not-a-date (%Y-%m-%d)".
        assert_eq!(engine.render("{{date d}}", &data).unwrap(), "not-a-date");
    }

    #[test]
    fn date_of_empty_is_empty() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "d": "" });
        assert_eq!(engine.render("{{date d}}", &data).unwrap(), "");
    }

    #[test]
    fn currency_handles_missing_values() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({});
        assert_eq!(engine.render("{{currency nope}}", &data).unwrap(), "$0.00");
    }

    #[test]
    fn currency_supports_custom_symbol() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "p": 3 });
        assert_eq!(
            engine.render("{{currency p \"€\"}}", &data).unwrap(),
            "€3.00"
        );
    }
}
