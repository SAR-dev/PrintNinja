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
    }

    pub fn render(&self, template: &str, data: &serde_json::Value) -> Result<String> {
        self.hb.render_template(template, data).map_err(Into::into)
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

    let format = h.param(1).and_then(|v| v.value().as_str()).unwrap_or("%Y-%m-%d");
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(engine.render("{{currency p \"€\"}}", &data).unwrap(), "€3.00");
    }
}
