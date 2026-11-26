//! Loading, set-level validation and user overrides (plan §5.10).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::{Profile, ProfileError};

/// Parse one profile from TOML text and validate it.
pub fn parse(text: &str) -> Result<Profile, ParseError> {
    let profile: Profile = toml::from_str(text).map_err(|e| ParseError::Toml(e.to_string()))?;
    profile
        .validate()
        .map(|_| profile)
        .map_err(ParseError::Validation)
}

/// Profile set load errors.
#[derive(Debug, thiserror::Error)]
pub enum ProfileSetError {
    #[error("no profile files in {0}")]
    EmptyDir(String),
    #[error("failed to read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("profile {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: ParseError,
    },
    #[error("duplicate model '{model}' ({a} and {b})")]
    DuplicateModel {
        model: String,
        a: PathBuf,
        b: PathBuf,
    },
    #[error("alias '{alias}' of {owner} collides with {other})")]
    AliasCollision {
        alias: String,
        owner: PathBuf,
        other: PathBuf,
    },
}

/// A loaded set of profiles, addressable by model or alias.
#[derive(Debug)]
pub struct ProfileSet {
    profiles: Vec<(PathBuf, Profile)>,
    index: HashMap<String, usize>,
}

impl ProfileSet {
    /// All loaded profiles, in directory order.
    pub fn profiles(&self) -> impl Iterator<Item = (PathBuf, &Profile)> {
        self.profiles.iter().map(|(path, p)| (path.clone(), p))
    }

    /// Find a profile by model name or alias (case-insensitive).
    pub fn find(&self, name_or_alias: &str) -> Option<&Profile> {
        self.index
            .get(&name_or_alias.to_ascii_lowercase())
            .map(|&i| &self.profiles[i].1)
    }
}

/// Load every `*.toml` in `dir`, validate each and the set (no model or
/// alias collisions).
pub fn load_dir(dir: impl AsRef<Path>) -> Result<ProfileSet, ProfileSetError> {
    let dir = dir.as_ref();
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| ProfileSetError::Read {
            path: dir.to_path_buf(),
            source: e,
        })?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("toml"))
        })
        .collect();
    files.sort();
    if files.is_empty() {
        return Err(ProfileSetError::EmptyDir(dir.display().to_string()));
    }

    let mut profiles: Vec<(PathBuf, Profile)> = Vec::with_capacity(files.len());
    let mut index: HashMap<String, usize> = HashMap::new();
    for path in &files {
        let text = std::fs::read_to_string(path).map_err(|e| ProfileSetError::Read {
            path: path.clone(),
            source: e,
        })?;
        let profile = parse(&text).map_err(|e| ProfileSetError::Parse {
            path: path.clone(),
            source: e,
        })?;
        let model_key = profile.profile.model.to_ascii_lowercase();
        if let Some(&existing) = index.get(&model_key) {
            return Err(ProfileSetError::DuplicateModel {
                model: profile.profile.model.clone(),
                a: profiles[existing].0.clone(),
                b: path.clone(),
            });
        }
        let names = std::iter::once(profile.profile.model.clone())
            .chain(profile.profile.aliases.iter().cloned());
        for name in names {
            let key = name.to_ascii_lowercase();
            match index.get(&key) {
                Some(&existing) if key != model_key => {
                    return Err(ProfileSetError::AliasCollision {
                        alias: name,
                        owner: path.clone(),
                        other: profiles[existing].0.clone(),
                    });
                }
                Some(_) => {}
                None => {
                    index.insert(key, profiles.len());
                }
            }
        }
        profiles.push((path.clone(), profile));
    }

    Ok(ProfileSet { profiles, index })
}

/// Field-by-field merge of a user override onto a base profile:
/// the base is serialised to TOML, the user file is deserialised as a
/// `toml::Value`, and tables are merged depth-first with user keys
/// winning. Arrays (aliases, media, fonts, quirks) are replaced
/// wholesale, not concatenated. The result is re-parsed and
/// re-validated, so an override that breaks a cross-field rule is
/// rejected, not silently applied.
pub fn merge(base: &Profile, user: &str) -> Result<Profile, ParseError> {
    let mut value: toml::Value = toml::to_string(base)
        .map_err(|e| ParseError::Toml(e.to_string()))?
        .parse()
        .map_err(|e: toml::de::Error| ParseError::Toml(e.to_string()))?;
    let user_value: toml::Value =
        toml::from_str(user).map_err(|e| ParseError::Toml(e.to_string()))?;
    merge_value(&mut value, user_value);
    let merged_text = toml::to_string(&value).map_err(|e| ParseError::Toml(e.to_string()))?;
    let profile: Profile =
        toml::from_str(&merged_text).map_err(|e| ParseError::Toml(e.to_string()))?;
    profile
        .validate()
        .map(|_| profile)
        .map_err(ParseError::Validation)
}

fn merge_value(base: &mut toml::Value, user: toml::Value) {
    match (base, user) {
        (toml::Value::Table(base_map), toml::Value::Table(user_map)) => {
            for (key, value) in user_map {
                match base_map.get_mut(&key) {
                    Some(existing) => merge_value(existing, value),
                    None => {
                        base_map.insert(key, value);
                    }
                }
            }
        }
        (base_slot, user_value) => {
            *base_slot = user_value;
        }
    }
}

/// Errors from parsing one profile.
#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("invalid TOML: {0}")]
    Toml(String),
    #[error(transparent)]
    Validation(#[from] ProfileError),
}
