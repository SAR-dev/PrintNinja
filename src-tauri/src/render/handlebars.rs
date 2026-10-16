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
    let format = h.param(1).and_then(|v| v.value().as_str()).unwrap_or("%Y-%m-%d");
    // Simple date formatting
    out.write(&format!("{} ({})", value, format))?;
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
    let pad = h.param(2).and_then(|v| v.value().as_str()).unwrap_or(" ");
    out.write(&format!("{:>width$}", value, width = width, pad = pad))?;
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
}
