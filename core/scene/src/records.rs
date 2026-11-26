//! Data records — the rows a scene is expanded against (plan §5.1).
//!
//! A record is an ordered mapping of field names to values
//! ([`Record`]). Values come in two shapes: plain text (`string`,
//! `number`, `boolean`, `date` — all coerced to their string form here)
//! and a list of records, which a group element repeats over.
//!
//! Records are read from JSON (an array of objects, or one bare
//! object) or CSV (RFC 4180: a header row, quoted fields, `\r\n` line
//! endings). CSV rows are flat
//! — every value is text — so a group bound to a CSV column that holds
//! rows of objects has no source and fails expansion honestly.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// One data record: field name → value.
///
/// A `BTreeMap`, so the field order in the expanded output is the
/// sorted field order — the same for every run, on every machine.
pub type Record = BTreeMap<String, Value>;

/// What a data field holds.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum Value {
    /// Plain text (a JSON string, number, boolean or null, coerced).
    Text(String),
    /// A list of records a group repeats over.
    Rows(Vec<Record>),
}

impl Value {
    /// The text of a value; a row list reads as an empty string.
    pub fn as_text(&self) -> &str {
        match self {
            Value::Text(s) => s,
            Value::Rows(_) => "",
        }
    }

    /// The rows of a value, if it is one.
    pub fn as_rows(&self) -> Option<&[Record]> {
        match self {
            Value::Rows(rows) => Some(rows),
            Value::Text(_) => None,
        }
    }
}

/// The rows a template is expanded against.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Records(pub Vec<Record>);

impl Records {
    /// Parse a JSON document: an array of objects, one object per
    /// record, or one bare object as a single record (a Data URL that
    /// serves a single label is one page; the copies field repeats it).
    /// Numbers and booleans are coerced to their string form; an array
    /// of objects becomes a row list (for group bindings).
    pub fn from_json(s: &str) -> Result<Self, RecordsError> {
        let v: serde_json::Value = serde_json::from_str(s)
            .map_err(|e| RecordsError(format!("the data is not valid JSON: {e}")))?;
        match v {
            serde_json::Value::Object(obj) => Ok(Records(vec![record_from_object(&obj)?])),
            serde_json::Value::Array(arr) => {
                let mut out = Vec::new();
                for (i, row) in arr.iter().enumerate() {
                    let obj = row.as_object().ok_or_else(|| {
                        RecordsError(format!(
                            "record {i} is not an object (a row is one object per record)"
                        ))
                    })?;
                    out.push(record_from_object(obj)?);
                }
                Ok(Records(out))
            }
            _ => Err(RecordsError(
                "the data must be a JSON object or an array of objects".into(),
            )),
        }
    }

    /// Parse CSV (RFC 4180): a header row of field names, then one row
    /// per record. A short row pads with empty text; a long row is an
    /// error. Quoted fields may contain commas, quotes (`""`) and
    /// newlines.
    pub fn from_csv(s: &str) -> Result<Self, RecordsError> {
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut row: Vec<String> = Vec::new();
        let mut field = String::new();
        let mut in_quotes = false;
        let mut chars = s.chars().peekable();
        let mut at_field_start = true;
        while let Some(c) = chars.next() {
            if in_quotes {
                if c == '"' {
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        field.push('"');
                    } else {
                        in_quotes = false;
                        at_field_start = false;
                    }
                } else {
                    field.push(c);
                }
            } else if c == '"' && at_field_start {
                in_quotes = true;
            } else if c == ',' {
                row.push(std::mem::take(&mut field));
                at_field_start = true;
            } else if c == '\r' {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(std::mem::take(&mut field));
                at_field_start = true;
                rows.push(std::mem::take(&mut row));
            } else if c == '\n' {
                row.push(std::mem::take(&mut field));
                at_field_start = true;
                rows.push(std::mem::take(&mut row));
            } else {
                field.push(c);
                at_field_start = false;
            }
        }
        // The last row, if the file does not end with a newline.
        if !field.is_empty() || !row.is_empty() {
            row.push(field);
            rows.push(row);
        }

        let rows = rows
            .into_iter()
            .filter(|r| !(r.len() == 1 && r[0].is_empty()))
            .collect::<Vec<_>>();
        let Some(header) = rows.first() else {
            return Ok(Records(Vec::new()));
        };
        let header = header.clone();
        if header.iter().any(|h| h.trim().is_empty()) {
            return Err(RecordsError(
                "the CSV header has an empty column name".into(),
            ));
        }
        let mut out = Vec::new();
        for (i, r) in rows.iter().enumerate().skip(1) {
            if r.len() > header.len() {
                return Err(RecordsError(format!(
                    "CSV row {i} has {} columns, but the header names {}",
                    r.len(),
                    header.len()
                )));
            }
            let mut rec = Record::new();
            for (j, name) in header.iter().enumerate() {
                let value = r.get(j).map_or("", String::as_str);
                rec.insert(name.clone(), Value::Text(value.to_string()));
            }
            out.push(rec);
        }
        Ok(Records(out))
    }

    /// Parse the data field as it arrives from the app, a local file
    /// or a data URL: JSON first (an array of objects, or one bare
    /// object), then CSV (a header row and its rows). When both refuse
    /// it, the CSV error is the one named — it is the more specific
    /// reading of the text.
    pub fn from_text(s: &str) -> Result<Self, RecordsError> {
        if let Ok(r) = Self::from_json(s) {
            return Ok(r);
        }
        Self::from_csv(s)
            .map_err(|csv_err| RecordsError(format!("the data is neither JSON nor CSV: {csv_err}")))
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// One object of a JSON record, with its values coerced.
fn record_from_object(
    obj: &serde_json::Map<String, serde_json::Value>,
) -> Result<Record, RecordsError> {
    let mut rec = Record::new();
    for (name, v) in obj {
        rec.insert(name.clone(), coerce(name, v)?);
    }
    Ok(rec)
}

/// Coerce a JSON value to a [`Value`]: scalars become text, an array of
/// objects becomes a row list, anything else is an error.
fn coerce(name: &str, v: &serde_json::Value) -> Result<Value, RecordsError> {
    match v {
        serde_json::Value::String(s) => Ok(Value::Text(s.clone())),
        serde_json::Value::Number(n) => Ok(Value::Text(n.to_string())),
        serde_json::Value::Bool(b) => Ok(Value::Text(b.to_string())),
        serde_json::Value::Null => Ok(Value::Text(String::new())),
        serde_json::Value::Object(o) => {
            Ok(Value::Text(o.keys().cloned().collect::<Vec<_>>().join(",")))
        }
        serde_json::Value::Array(items) => {
            let rows = items
                .iter()
                .map(|item| {
                    let obj = item.as_object().ok_or_else(|| {
                        RecordsError(format!(
                            "field \"{name}\" is a list, but entry {item} is not an \
                             object — a list field must hold one object per row"
                        ))
                    })?;
                    record_from_object(obj)
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Value::Rows(rows))
        }
    }
}

/// The data was not what a record file is.
#[derive(Debug)]
pub struct RecordsError(String);

impl std::fmt::Display for RecordsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RecordsError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_scalars_coerce_to_text_and_rows_stay_rows() {
        let r = Records::from_json(
            r#"[ { "name": "Ada", "qty": 3, "free": true, "rows": [
                  { "item": "pen", "price": "1.20" }, { "item": "ink" } ] } ]"#,
        )
        .unwrap();
        let rec = &r.0[0];
        assert_eq!(rec["name"].as_text(), "Ada");
        assert_eq!(rec["qty"].as_text(), "3");
        assert_eq!(rec["free"].as_text(), "true");
        let rows = rec["rows"].as_rows().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["item"].as_text(), "pen");
    }

    #[test]
    fn json_that_is_not_an_object_or_array_of_objects_is_named() {
        assert!(Records::from_json(r#"[ "not an object" ]"#).is_err());
        assert!(Records::from_json(r#"[ { "rows": [ 1 ] } ]"#).is_err());
        assert!(Records::from_json("42").is_err());
        assert!(Records::from_json("nope").is_err());
    }

    #[test]
    fn a_bare_json_object_is_a_single_record() {
        // The shape a data URL serves most often: one object, one
        // label — the copies field repeats it.
        let r = Records::from_json(r#"{"name": "Ada", "qty": 2}"#).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r.0[0]["name"].as_text(), "Ada");
        assert_eq!(r.0[0]["qty"].as_text(), "2");
        assert!(Records::from_json(r#"{}"#).unwrap().0[0].is_empty());
    }

    #[test]
    fn csv_parses_quotes_commas_and_escaped_quotes() {
        let r =
            Records::from_csv("name,note\r\nAda,\"a, b\"\r\nBob,\"say \"\"hi\"\"\"\r\n").unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r.0[0]["name"].as_text(), "Ada");
        assert_eq!(r.0[0]["note"].as_text(), "a, b");
        assert_eq!(r.0[1]["note"].as_text(), "say \"hi\"");
    }

    #[test]
    fn csv_short_rows_pad_and_long_rows_fail() {
        let r = Records::from_csv("a,b\n1\n").unwrap();
        assert_eq!(r.0[0]["b"].as_text(), "");
        assert!(Records::from_csv("a,b\n1,2,3\n").is_err());
    }

    #[test]
    fn an_empty_csv_is_an_empty_batch() {
        assert!(Records::from_csv("").unwrap().is_empty());
        assert!(Records::from_json("[]").unwrap().is_empty());
    }

    #[test]
    fn from_text_reads_json_and_csv_alike() {
        let json = Records::from_text(r#"[{"name":"Ada"}]"#).unwrap();
        assert_eq!(json.0[0]["name"].as_text(), "Ada");
        let csv = Records::from_text("name,qty\nAda,3\n").unwrap();
        assert_eq!(csv.0[0]["name"].as_text(), "Ada");
        assert_eq!(csv.0[0]["qty"].as_text(), "3");
    }

    #[test]
    fn from_text_names_data_that_is_neither() {
        let err = Records::from_text("a,b\n1,2,3\n").unwrap_err();
        assert!(err.to_string().contains("neither JSON nor CSV"));
    }
}
