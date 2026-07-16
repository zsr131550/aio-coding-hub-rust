use crate::{db, settings};
use base64::Engine as _;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const FIXED_FIXTURE_EPOCH: i64 = 1_700_000_000;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SchemaRow {
    object_type: String,
    name: String,
    table_name: String,
    sql: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SchemaObjectShape {
    object_type: String,
    name: String,
    table_name: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TableColumnShape {
    name: String,
    declared_type: String,
    not_null: bool,
    default_value: Option<String>,
    primary_key_position: i64,
    hidden: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
struct ForeignKeyColumnShape {
    from_column: String,
    to_column: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
struct ForeignKeyShape {
    referenced_table: String,
    columns: Vec<ForeignKeyColumnShape>,
    on_update: String,
    on_delete: String,
    match_rule: String,
}

#[derive(Debug)]
struct ForeignKeyRow {
    id: i64,
    seq: i64,
    referenced_table: String,
    from_column: String,
    to_column: Option<String>,
    on_update: String,
    on_delete: String,
    match_rule: String,
}

#[derive(Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(tag = "kind", content = "name", rename_all = "camelCase")]
enum IndexColumnSource {
    Column(String),
    RowId,
}

#[derive(Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
struct IndexColumnShape {
    source: IndexColumnSource,
    descending: bool,
    collation: Option<String>,
    key: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
struct IndexShape {
    explicit_name: Option<String>,
    unique: bool,
    origin: String,
    partial: bool,
    partial_predicate: Option<String>,
    columns: Vec<IndexColumnShape>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TableShape {
    name: String,
    columns: Vec<TableColumnShape>,
    foreign_keys: Vec<ForeignKeyShape>,
    indexes: Vec<IndexShape>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SemanticSchemaShape {
    objects: Vec<SchemaObjectShape>,
    tables: Vec<TableShape>,
}

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("egui-migration")
}

fn canonical_schema(conn: &Connection) -> Vec<SchemaRow> {
    let mut statement = conn
        .prepare(
            r#"
SELECT type, name, tbl_name, sql
FROM sqlite_schema
WHERE name NOT GLOB 'sqlite_*'
ORDER BY type, name, tbl_name
"#,
        )
        .expect("prepare sqlite_schema snapshot");
    statement
        .query_map([], |row| {
            Ok(SchemaRow {
                object_type: row.get(0)?,
                name: row.get(1)?,
                table_name: row.get(2)?,
                sql: row.get(3)?,
            })
        })
        .expect("query sqlite_schema snapshot")
        .map(|row| row.expect("read sqlite_schema row"))
        .collect()
}

fn canonical_schema_bytes(conn: &Connection) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(&canonical_schema(conn))
        .expect("serialize sqlite_schema snapshot");
    bytes.push(b'\n');
    bytes
}

fn sqlite_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn normalize_declared_type(value: String) -> String {
    value
        .split_ascii_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase()
}

fn partial_index_predicate(conn: &Connection, index_name: &str) -> String {
    let sql = conn
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?1",
            [index_name],
            |row| row.get::<_, Option<String>>(0),
        )
        .expect("read partial index SQL")
        .expect("partial index must have explicit SQL");
    let upper = sql.to_ascii_uppercase();
    let offset = upper
        .find(" WHERE ")
        .expect("partial index SQL must contain a WHERE predicate");
    sql[offset + " WHERE ".len()..].trim().to_string()
}

fn table_shape(conn: &Connection, name: &str) -> TableShape {
    let literal = sqlite_string_literal(name);
    let mut columns_statement = conn
        .prepare(&format!("PRAGMA table_xinfo({literal})"))
        .expect("prepare table_xinfo");
    let mut columns = columns_statement
        .query_map([], |row| {
            Ok(TableColumnShape {
                name: row.get(1)?,
                declared_type: normalize_declared_type(row.get(2)?),
                not_null: row.get::<_, i64>(3)? != 0,
                default_value: row
                    .get::<_, Option<String>>(4)?
                    .map(|value| value.trim().to_string()),
                primary_key_position: row.get(5)?,
                hidden: row.get(6)?,
            })
        })
        .expect("query table_xinfo")
        .map(|row| row.expect("read table_xinfo row"))
        .collect::<Vec<_>>();
    columns.sort_by(|left, right| left.name.cmp(&right.name));

    let mut foreign_keys_statement = conn
        .prepare(&format!("PRAGMA foreign_key_list({literal})"))
        .expect("prepare foreign_key_list");
    let foreign_key_rows = foreign_keys_statement
        .query_map([], |row| {
            Ok(ForeignKeyRow {
                id: row.get(0)?,
                seq: row.get(1)?,
                referenced_table: row.get(2)?,
                from_column: row.get(3)?,
                to_column: row.get(4)?,
                on_update: row.get(5)?,
                on_delete: row.get(6)?,
                match_rule: row.get(7)?,
            })
        })
        .expect("query foreign_key_list")
        .map(|row| row.expect("read foreign_key_list row"))
        .collect::<Vec<_>>();
    let mut foreign_key_groups = BTreeMap::<i64, Vec<ForeignKeyRow>>::new();
    for row in foreign_key_rows {
        foreign_key_groups.entry(row.id).or_default().push(row);
    }
    let mut foreign_keys = foreign_key_groups
        .into_values()
        .map(|mut rows| {
            rows.sort_by_key(|row| row.seq);
            let first = rows.first().expect("foreign key group must not be empty");
            assert!(rows.iter().all(|row| {
                row.referenced_table == first.referenced_table
                    && row.on_update == first.on_update
                    && row.on_delete == first.on_delete
                    && row.match_rule == first.match_rule
            }));
            ForeignKeyShape {
                referenced_table: first.referenced_table.clone(),
                columns: rows
                    .iter()
                    .map(|row| ForeignKeyColumnShape {
                        from_column: row.from_column.clone(),
                        to_column: row.to_column.clone(),
                    })
                    .collect(),
                on_update: first.on_update.clone(),
                on_delete: first.on_delete.clone(),
                match_rule: first.match_rule.clone(),
            }
        })
        .collect::<Vec<_>>();
    foreign_keys.sort();

    let mut indexes_statement = conn
        .prepare(&format!("PRAGMA index_list({literal})"))
        .expect("prepare index_list");
    let mut indexes = indexes_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)? != 0,
            ))
        })
        .expect("query index_list")
        .map(|row| row.expect("read index_list row"))
        .map(|(index_name, unique, origin, partial)| {
            let index_literal = sqlite_string_literal(&index_name);
            let mut columns_statement = conn
                .prepare(&format!("PRAGMA index_xinfo({index_literal})"))
                .expect("prepare index_xinfo");
            let mut columns = columns_statement
                .query_map([], |row| {
                    let cid = row.get::<_, i64>(1)?;
                    let name = row.get::<_, Option<String>>(2)?;
                    let source = match cid {
                        -1 => IndexColumnSource::RowId,
                        -2 => panic!(
                            "expression index {index_name} requires a SQL parser before semantic comparison"
                        ),
                        _ => IndexColumnSource::Column(
                            name.expect("ordinary index column must have a name"),
                        ),
                    };
                    Ok((
                        row.get::<_, i64>(0)?,
                        IndexColumnShape {
                            source,
                            descending: row.get::<_, i64>(3)? != 0,
                            collation: row.get(4)?,
                            key: row.get::<_, i64>(5)? != 0,
                        },
                    ))
                })
                .expect("query index_xinfo")
                .map(|row| row.expect("read index_xinfo row"))
                .collect::<Vec<_>>();
            columns.sort_by_key(|(seq_no, _)| *seq_no);
            IndexShape {
                explicit_name: (origin == "c").then(|| index_name.clone()),
                unique,
                origin: origin.clone(),
                partial,
                partial_predicate: partial.then(|| partial_index_predicate(conn, &index_name)),
                columns: columns.into_iter().map(|(_, column)| column).collect(),
            }
        })
        .collect::<Vec<_>>();
    indexes.sort();

    TableShape {
        name: name.to_string(),
        columns,
        foreign_keys,
        indexes,
    }
}

fn semantic_schema_shape_bytes(conn: &Connection) -> Vec<u8> {
    let schema = canonical_schema(conn);
    let objects = schema
        .iter()
        .map(|row| {
            assert!(
                matches!(row.object_type.as_str(), "table" | "index"),
                "semantic schema comparison needs explicit support for {} objects",
                row.object_type
            );
            SchemaObjectShape {
                object_type: row.object_type.clone(),
                name: row.name.clone(),
                table_name: row.table_name.clone(),
            }
        })
        .collect();
    let tables = schema
        .iter()
        .filter(|row| row.object_type == "table")
        .map(|row| table_shape(conn, &row.name))
        .collect();
    let mut bytes = serde_json::to_vec_pretty(&SemanticSchemaShape { objects, tables })
        .expect("serialize semantic schema shape");
    bytes.push(b'\n');
    bytes
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_user_version(conn: &Connection) -> i64 {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("read sqlite user_version")
}

fn normalize_current_database(path: &Path) {
    let database =
        db::init_for_tests(path).expect("create current database with production migrations");
    {
        let conn = database
            .open_connection()
            .expect("open generated current database");
        conn.execute(
            "UPDATE schema_migrations SET applied_at = ?1",
            [FIXED_FIXTURE_EPOCH],
        )
        .expect("normalize migration timestamps");
        conn.execute(
            "UPDATE skill_repos SET created_at = ?1, updated_at = ?1",
            [FIXED_FIXTURE_EPOCH],
        )
        .expect("normalize seeded skill repository timestamps");
        conn.execute(
            "UPDATE workspaces SET created_at = ?1, updated_at = ?1",
            [FIXED_FIXTURE_EPOCH],
        )
        .expect("normalize seeded workspace timestamps");
        conn.execute(
            "UPDATE workspace_active SET updated_at = ?1",
            [FIXED_FIXTURE_EPOCH],
        )
        .expect("normalize active workspace timestamps");
    }
    drop(database);

    let conn = Connection::open(path).expect("reopen generated current database");
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .expect("checkpoint generated current database");
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode = DELETE", [], |row| row.get(0))
        .expect("switch generated current database journal mode");
    assert_eq!(journal_mode.to_ascii_lowercase(), "delete");
    conn.execute_batch("PRAGMA page_size = 4096; VACUUM;")
        .expect("vacuum generated current database");
}

#[derive(Debug, PartialEq, Eq)]
struct FixtureExportPaths {
    current_db: PathBuf,
    current_schema: PathBuf,
    v25_schema: PathBuf,
    settings: PathBuf,
}

fn fixture_path_identity(path: &Path) -> String {
    let identity = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        identity.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        identity
    }
}

fn validate_fixture_export_paths(
    staging_root: &Path,
    current_db: &Path,
    v25_schema: &Path,
    settings: &Path,
) -> Result<FixtureExportPaths, String> {
    if !staging_root.is_absolute() {
        return Err("fixture staging root must be absolute".to_string());
    }
    let canonical_root = staging_root.canonicalize().map_err(|error| {
        format!(
            "fixture staging root must be an existing directory {}: {error}",
            staging_root.display()
        )
    })?;
    if !canonical_root.is_dir() {
        return Err(format!(
            "fixture staging root must be a directory: {}",
            staging_root.display()
        ));
    }

    let current_schema = current_db.with_extension("schema.json");
    let requested = [
        ("current database", current_db),
        ("current schema", current_schema.as_path()),
        ("v25 schema", v25_schema),
        ("settings", settings),
    ];
    let mut normalized = Vec::with_capacity(requested.len());
    let mut identities = std::collections::BTreeSet::new();

    for (label, path) in requested {
        if !path.is_absolute() {
            return Err(format!(
                "fixture output must be absolute ({label}): {}",
                path.display()
            ));
        }
        match std::fs::symlink_metadata(path) {
            Ok(_) => {
                return Err(format!(
                    "fixture output already exists ({label}): {}",
                    path.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "failed to inspect fixture output ({label}) {}: {error}",
                    path.display()
                ));
            }
        }

        let parent = path
            .parent()
            .ok_or_else(|| format!("fixture output has no parent ({label}): {}", path.display()))?;
        let canonical_parent = parent.canonicalize().map_err(|error| {
            format!(
                "fixture output parent must exist ({label}) {}: {error}",
                parent.display()
            )
        })?;
        if !canonical_parent.starts_with(&canonical_root) {
            return Err(format!(
                "fixture output is outside fixture staging root ({label}): {}",
                path.display()
            ));
        }
        let file_name = path.file_name().ok_or_else(|| {
            format!(
                "fixture output must name a file ({label}): {}",
                path.display()
            )
        })?;
        let canonical_output = canonical_parent.join(file_name);
        if !identities.insert(fixture_path_identity(&canonical_output)) {
            return Err(format!(
                "fixture outputs must be distinct; duplicate path ({label}): {}",
                path.display()
            ));
        }
        normalized.push(canonical_output);
    }

    let mut normalized = normalized.into_iter();
    Ok(FixtureExportPaths {
        current_db: normalized.next().expect("current database path"),
        current_schema: normalized.next().expect("current schema path"),
        v25_schema: normalized.next().expect("v25 schema path"),
        settings: normalized.next().expect("settings path"),
    })
}

#[test]
fn fixture_export_paths_accept_four_fresh_distinct_outputs_in_staging_root() {
    let staging = tempfile::tempdir().expect("create fixture export staging root");
    let current_db = staging.path().join("aio-coding-hub.db");
    let v25_schema = staging.path().join("sqlite-v25.schema.json");
    let settings = staging.path().join("settings-current.json");

    let paths = validate_fixture_export_paths(staging.path(), &current_db, &v25_schema, &settings)
        .expect("validate isolated fixture export paths");

    let canonical_staging = staging
        .path()
        .canonicalize()
        .expect("canonical staging root");
    assert_eq!(
        paths.current_db,
        canonical_staging.join("aio-coding-hub.db")
    );
    assert_eq!(
        paths.current_schema,
        canonical_staging.join("aio-coding-hub.schema.json")
    );
    assert_eq!(
        paths.v25_schema,
        canonical_staging.join("sqlite-v25.schema.json")
    );
    assert_eq!(
        paths.settings,
        canonical_staging.join("settings-current.json")
    );
}

#[test]
fn fixture_export_paths_reject_relative_and_outside_paths() {
    let parent = tempfile::tempdir().expect("create fixture export parent");
    let staging = parent.path().join("staging");
    std::fs::create_dir(&staging).expect("create staging root");
    let current_db = staging.join("aio-coding-hub.db");
    let v25_schema = staging.join("sqlite-v25.schema.json");
    let settings = staging.join("settings-current.json");

    let relative_error = validate_fixture_export_paths(
        Path::new("relative-staging"),
        &current_db,
        &v25_schema,
        &settings,
    )
    .expect_err("relative staging root must be rejected");
    assert!(relative_error.contains("staging root must be absolute"));

    let relative_output_error = validate_fixture_export_paths(
        &staging,
        Path::new("aio-coding-hub.db"),
        &v25_schema,
        &settings,
    )
    .expect_err("relative output must be rejected");
    assert!(relative_output_error.contains("fixture output must be absolute"));

    let outside_error = validate_fixture_export_paths(
        &staging,
        &current_db,
        &parent.path().join("outside.schema.json"),
        &settings,
    )
    .expect_err("output outside staging root must be rejected");
    assert!(outside_error.contains("outside fixture staging root"));
}

#[test]
fn fixture_export_paths_reject_sidecar_alias_and_existing_output() {
    let staging = tempfile::tempdir().expect("create fixture export staging root");
    let current_db = staging.path().join("aio-coding-hub.db");
    let current_schema = current_db.with_extension("schema.json");
    let v25_schema = staging.path().join("sqlite-v25.schema.json");
    let alias_dir = staging.path().join("alias");
    std::fs::create_dir(&alias_dir).expect("create path alias directory");
    let aliased_current_schema = alias_dir.join("..").join("aio-coding-hub.schema.json");

    let alias_error = validate_fixture_export_paths(
        staging.path(),
        &current_db,
        &v25_schema,
        &aliased_current_schema,
    )
    .expect_err("schema sidecar alias must be rejected");
    assert!(alias_error.contains("fixture outputs must be distinct"));

    std::fs::write(&current_schema, b"occupied").expect("create occupied schema sidecar");
    let exists_error = validate_fixture_export_paths(
        staging.path(),
        &current_db,
        &v25_schema,
        &staging.path().join("settings-current.json"),
    )
    .expect_err("existing schema sidecar must be rejected");
    assert!(exists_error.contains("fixture output already exists"));
}

#[test]
#[ignore = "explicit fixture regeneration only"]
fn export_current_egui_database_fixture() {
    let staging_root = std::env::var_os("AIO_EGUI_FIXTURE_STAGING_ROOT")
        .map(PathBuf::from)
        .expect("AIO_EGUI_FIXTURE_STAGING_ROOT must be set");
    let current_db = std::env::var_os("AIO_EGUI_CURRENT_DB_OUTPUT")
        .map(PathBuf::from)
        .expect("AIO_EGUI_CURRENT_DB_OUTPUT must be set");
    let v25_schema_output = std::env::var_os("AIO_EGUI_V25_SCHEMA_OUTPUT")
        .map(PathBuf::from)
        .expect("AIO_EGUI_V25_SCHEMA_OUTPUT must be set");
    let settings_output = std::env::var_os("AIO_EGUI_SETTINGS_OUTPUT")
        .map(PathBuf::from)
        .expect("AIO_EGUI_SETTINGS_OUTPUT must be set");
    let paths = validate_fixture_export_paths(
        &staging_root,
        &current_db,
        &v25_schema_output,
        &settings_output,
    )
    .expect("validate fixture export paths before writing");

    normalize_current_database(&paths.current_db);
    let conn = Connection::open(&paths.current_db).expect("open generated current fixture");
    assert_eq!(read_user_version(&conn), db::LATEST_SCHEMA_VERSION);
    let schema_bytes = canonical_schema_bytes(&conn);
    std::fs::write(&paths.current_schema, &schema_bytes)
        .expect("write generated current schema snapshot");
    eprintln!(
        "current fixture schema sha256={}",
        sha256_hex(&schema_bytes)
    );

    let v25 = Connection::open(
        fixture_root()
            .join("data")
            .join("sqlite-v25")
            .join("aio-coding-hub.db"),
    )
    .expect("open authoritative v25 fixture");
    let v25_schema_bytes = canonical_schema_bytes(&v25);
    std::fs::write(&paths.v25_schema, &v25_schema_bytes)
        .expect("write generated v25 schema snapshot");
    eprintln!(
        "v25 fixture schema sha256={}",
        sha256_hex(&v25_schema_bytes)
    );

    let settings_fixture = representative_settings_fixture();
    settings::validate_bounds(&settings_fixture).expect("validate representative settings");
    let mut settings_bytes = serde_json::to_vec_pretty(
        &settings::canonical_settings_json(&settings_fixture)
            .expect("canonicalize representative settings"),
    )
    .expect("serialize representative settings");
    settings_bytes.push(b'\n');
    std::fs::write(&paths.settings, settings_bytes).expect("write current settings fixture");
}

#[test]
fn committed_sqlite_fixtures_match_schema_snapshots_and_migrate() {
    let root = fixture_root().join("data");
    let v25_path = root.join("sqlite-v25").join("aio-coding-hub.db");
    let current_path = root.join("sqlite-current").join("aio-coding-hub.db");
    let fresh_marker: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("fresh").join("fixture.json"))
            .expect("read committed fresh fixture marker"),
    )
    .expect("parse committed fresh fixture marker");
    assert_eq!(fresh_marker["schemaVersion"], 1);
    assert_eq!(fresh_marker["expectedDatabaseState"], "absent");

    let v25 = Connection::open(&v25_path).expect("open committed v25 fixture");
    assert_eq!(read_user_version(&v25), db::MIN_SUPPORTED_SCHEMA_VERSION);
    let expected_v25_schema = std::fs::read(root.join("sqlite-v25").join("schema.json"))
        .expect("read committed v25 schema snapshot");
    assert_eq!(canonical_schema_bytes(&v25), expected_v25_schema);
    drop(v25);

    let current = Connection::open(&current_path).expect("open committed current fixture");
    assert_eq!(read_user_version(&current), db::LATEST_SCHEMA_VERSION);
    let expected_current_schema = std::fs::read(root.join("sqlite-current").join("schema.json"))
        .expect("read committed current schema snapshot");
    assert_eq!(canonical_schema_bytes(&current), expected_current_schema);
    let expected_current_semantic_schema = semantic_schema_shape_bytes(&current);
    drop(current);

    let temp = tempfile::tempdir().expect("create temporary migration directory");
    let fresh_path = temp.path().join("fresh.db");
    assert!(!fresh_path.exists());
    let fresh = db::init_for_tests(&fresh_path).expect("initialize a fresh production database");
    {
        let fresh_conn = fresh
            .open_connection()
            .expect("open initialized fresh database");
        assert_eq!(read_user_version(&fresh_conn), db::LATEST_SCHEMA_VERSION);
        assert_eq!(canonical_schema_bytes(&fresh_conn), expected_current_schema);
    }
    drop(fresh);

    let temporary_current_path = temp.path().join("current.db");
    std::fs::copy(&current_path, &temporary_current_path)
        .expect("copy current fixture into temporary directory");
    let temporary_current = db::init_for_tests(&temporary_current_path)
        .expect("open current fixture via production DB");
    {
        let current_conn = temporary_current
            .open_connection()
            .expect("open temporary current fixture");
        assert_eq!(read_user_version(&current_conn), db::LATEST_SCHEMA_VERSION);
        assert_eq!(
            canonical_schema_bytes(&current_conn),
            expected_current_schema
        );
    }
    drop(temporary_current);

    let migrated_path = temp.path().join("migrated-v25.db");
    std::fs::copy(&v25_path, &migrated_path).expect("copy v25 fixture into temporary directory");
    let migrated = db::init_for_tests(&migrated_path).expect("migrate committed v25 fixture");
    {
        let migrated_conn = migrated
            .open_connection()
            .expect("open migrated v25 fixture");
        assert_eq!(read_user_version(&migrated_conn), db::LATEST_SCHEMA_VERSION);
        assert_eq!(
            sha256_hex(&semantic_schema_shape_bytes(&migrated_conn)),
            sha256_hex(&expected_current_semantic_schema),
            "migrated v25 semantic schema must match the current fixture"
        );
    }
    drop(migrated);
    drop(db::init_for_tests(&migrated_path).expect("reopen migrated fixture idempotently"));
}

fn representative_settings_fixture() -> settings::AppSettings {
    settings::AppSettings {
        enable_notification_sound: false,
        ..settings::AppSettings::default()
    }
}

#[test]
fn committed_settings_fixture_is_current_canonical_and_non_default() {
    let path = fixture_root()
        .join("settings")
        .join("settings-current.json");
    let content = std::fs::read_to_string(path).expect("read current settings fixture");
    let (parsed, schema_present, _) =
        settings::parse_settings_json(&content).expect("parse current settings fixture");
    assert!(schema_present);
    settings::validate_bounds(&parsed).expect("validate current settings fixture");
    assert_eq!(parsed.schema_version, settings::SCHEMA_VERSION);
    let expected = representative_settings_fixture();
    assert_eq!(
        settings::canonical_settings_json(&parsed).expect("canonicalize settings fixture"),
        settings::canonical_settings_json(&expected).expect("canonicalize representative settings")
    );
    assert_ne!(
        settings::canonical_settings_json(&parsed).expect("canonicalize settings fixture"),
        settings::canonical_settings_json(&settings::AppSettings::default())
            .expect("canonicalize default settings")
    );
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureCase {
    id: String,
    path: String,
    expected_stage: String,
    expected_code: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FixtureCases {
    cases: Vec<FixtureCase>,
}

#[test]
fn committed_plugin_manifest_corpus_matches_production_parser_and_validator() {
    let root = fixture_root().join("plugins").join("manifest-corpus");
    let cases: FixtureCases = serde_json::from_slice(
        &std::fs::read(root.join("cases.json")).expect("read plugin fixture cases"),
    )
    .expect("parse plugin fixture cases");

    for case in cases.cases {
        let bytes = std::fs::read(root.join(&case.path)).expect("read plugin manifest fixture");
        let actual_code = crate::infra::plugins::package::parse_plugin_manifest_bytes(&bytes)
            .map_err(|error| error.code().to_string())
            .and_then(|manifest| {
                crate::plugins::validate_manifest(&manifest, env!("CARGO_PKG_VERSION"))
                    .map_err(|error| error.code)
            })
            .err();
        assert_eq!(
            actual_code, case.expected_code,
            "unexpected {} error code for {}",
            case.expected_stage, case.id
        );
    }
}

#[test]
fn committed_representative_plugin_config_matches_runtime_validator() {
    let root = fixture_root()
        .join("plugins")
        .join("plugin-api-v1")
        .join("representative");
    let manifest_bytes =
        std::fs::read(root.join("plugin.json")).expect("read representative plugin manifest");
    let manifest = crate::infra::plugins::package::parse_plugin_manifest_bytes(&manifest_bytes)
        .expect("parse representative plugin manifest through production parser");
    crate::plugins::validate_manifest(&manifest, env!("CARGO_PKG_VERSION"))
        .expect("validate representative plugin manifest");
    let config = serde_json::from_slice::<serde_json::Value>(
        &std::fs::read(root.join("config.json")).expect("read representative plugin config"),
    )
    .expect("parse representative plugin config");

    crate::app::plugin_service::validate_config_against_schema(
        manifest.config_schema.as_ref(),
        &config,
    )
    .expect("representative config must pass the runtime validator");

    let invalid_config = serde_json::json!({ "enabled": "not-a-boolean" });
    let error = crate::app::plugin_service::validate_config_against_schema(
        manifest.config_schema.as_ref(),
        &invalid_config,
    )
    .expect_err("runtime validator must enforce the representative boolean schema");
    assert_eq!(error.code(), "PLUGIN_INVALID_CONFIG");
}

#[test]
fn committed_extension_host_transcript_covers_runtime_protocol() {
    let plugin_root = fixture_root().join("plugins");
    let content = std::fs::read_to_string(
        plugin_root
            .join("transcripts")
            .join("valid-lifecycle.jsonl"),
    )
    .expect("read extension host transcript");
    let rows = content
        .lines()
        .enumerate()
        .map(|(index, line)| {
            serde_json::from_str::<serde_json::Value>(line)
                .unwrap_or_else(|error| panic!("invalid transcript row {index}: {error}"))
        })
        .collect::<Vec<_>>();
    let mut methods = std::collections::BTreeSet::new();
    for row in &rows {
        assert!(matches!(
            row["direction"].as_str(),
            Some("host-to-worker" | "worker-to-host")
        ));
        assert_eq!(row["message"]["jsonrpc"], "2.0");
        if let Some(method) = row["message"]["method"].as_str() {
            methods.insert(method.to_string());
        }
    }

    for method in crate::app::plugins::extension_host_worker::EXTENSION_HOST_METHODS
        .iter()
        .chain(crate::app::plugins::extension_host_worker::EXTENSION_HOST_NOTIFICATIONS)
    {
        assert!(methods.contains(*method), "transcript is missing {method}");
    }

    assert_eq!(rows.len(), 13, "unexpected lifecycle transcript length");
    assert_eq!(
        rows[0]["message"]["params"]["workerVersion"],
        crate::app::plugins::extension_host_worker::WORKER_VERSION
    );

    let manifest: crate::plugins::PluginManifest = serde_json::from_slice(
        &std::fs::read(
            plugin_root
                .join("plugin-api-v1")
                .join("representative")
                .join("plugin.json"),
        )
        .expect("read representative plugin manifest"),
    )
    .expect("parse representative plugin manifest");
    let handshake = &rows[1]["message"];
    assert_eq!(
        handshake["method"],
        crate::app::plugins::extension_host_worker::EXTENSION_HANDSHAKE_METHOD
    );
    assert_eq!(handshake["params"]["pluginId"], manifest.id);
    assert_eq!(handshake["params"]["version"], manifest.version);
    assert_eq!(handshake["params"]["apiVersion"], manifest.api_version);
    let contribution_hash = crate::domain::plugins::extension_host_contribution_hash(&manifest);
    assert_eq!(
        contribution_hash, "03ebd7a25255c34fe6f38d284bf9a6d818838c78841903885d61a19b6e6b7335",
        "the Node fixture hash must remain locked to the production algorithm"
    );
    assert_eq!(handshake["params"]["contributionHash"], contribution_hash);
    assert_eq!(rows[2]["message"]["id"], handshake["id"]);
    assert_eq!(rows[2]["message"]["result"]["pluginId"], manifest.id);
    assert_eq!(rows[2]["message"]["result"]["version"], manifest.version);
    assert_eq!(
        rows[2]["message"]["result"]["apiVersion"],
        manifest.api_version
    );
    assert_eq!(
        rows[2]["message"]["result"]["workerVersion"],
        crate::app::plugins::extension_host_worker::WORKER_VERSION
    );
    let validated_result =
        crate::app::plugins::extension_host_worker::validate_extension_host_handshake(
            &manifest,
            Some(&contribution_hash),
            &contribution_hash,
            &handshake["params"],
        )
        .expect("valid transcript handshake must pass production validation");
    assert_eq!(validated_result, rows[2]["message"]["result"]);
    assert!(rows[3]["message"]["params"].is_null());
    assert_eq!(rows[6]["message"]["id"], 1);
    assert_eq!(rows[7]["message"]["id"], rows[6]["message"]["id"]);
    assert!(rows[11]["message"]["params"].is_null());

    let invalid_content = std::fs::read_to_string(
        plugin_root
            .join("transcripts")
            .join("invalid-handshake.jsonl"),
    )
    .expect("read invalid extension host transcript");
    let invalid_rows = invalid_content
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("parse invalid row"))
        .collect::<Vec<_>>();
    assert_eq!(invalid_rows.len(), 2);
    let invalid_handshake = &invalid_rows[0]["message"];
    assert_eq!(invalid_handshake["method"], handshake["method"]);
    assert_ne!(
        invalid_handshake["params"]["pluginId"],
        handshake["params"]["pluginId"]
    );
    for field in ["version", "apiVersion", "contributionHash"] {
        assert_eq!(
            invalid_handshake["params"][field], handshake["params"][field],
            "invalid handshake must only change pluginId"
        );
    }
    assert_eq!(invalid_rows[1]["message"]["id"], invalid_handshake["id"]);
    let validation_error =
        crate::app::plugins::extension_host_worker::validate_extension_host_handshake(
            &manifest,
            Some(&contribution_hash),
            &contribution_hash,
            &invalid_handshake["params"],
        )
        .expect_err("invalid transcript handshake must fail production validation");
    assert_eq!(
        invalid_rows[1]["message"]["error"]["data"]["code"],
        validation_error.code
    );
    assert_eq!(
        invalid_rows[1]["message"]["error"]["message"],
        validation_error.message
    );
}

#[test]
fn committed_updater_manifest_parses_with_production_remote_release_type() {
    let root = fixture_root().join("updater").join("valid");
    let path = root.join("latest.json");
    let release: tauri_plugin_updater::RemoteRelease =
        serde_json::from_slice(&std::fs::read(path).expect("read valid updater fixture"))
            .expect("parse valid updater fixture");
    assert_eq!(release.version.to_string(), env!("CARGO_PKG_VERSION"));
    for target in [
        "windows-x86_64",
        "darwin-x86_64",
        "darwin-aarch64",
        "linux-x86_64",
    ] {
        assert_eq!(
            release
                .download_url(target)
                .expect("fixture target URL")
                .scheme(),
            "https"
        );
        assert!(!release
            .signature(target)
            .expect("fixture target signature")
            .is_empty());
    }
    assert!(release.download_url("unsupported-fixture-target").is_err());

    let public_key = std::fs::read_to_string(root.join("test-public-key.txt"))
        .expect("read updater fixture public key");
    let signature = release
        .signature("windows-x86_64")
        .expect("read updater fixture signature");
    let asset = std::fs::read(root.join("fixture-asset.bin")).expect("read updater fixture asset");
    verify_fixture_updater_signature(&asset, signature, &public_key)
        .expect("verify signed updater fixture asset");
    let mut tampered = asset;
    tampered[0] ^= 1;
    assert!(verify_fixture_updater_signature(&tampered, signature, &public_key).is_err());
}

fn decode_updater_base64_text(value: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|error| format!("invalid outer base64: {error}"))?;
    String::from_utf8(bytes).map_err(|error| format!("minisign text is not UTF-8: {error}"))
}

fn verify_fixture_updater_signature(
    asset: &[u8],
    release_signature: &str,
    encoded_public_key: &str,
) -> Result<(), String> {
    let public_key = decode_updater_base64_text(encoded_public_key)?;
    let public_key = minisign_verify::PublicKey::decode(&public_key)
        .map_err(|error| format!("invalid minisign public key: {error}"))?;
    let signature = decode_updater_base64_text(release_signature)?;
    let signature = minisign_verify::Signature::decode(&signature)
        .map_err(|error| format!("invalid minisign signature: {error}"))?;
    public_key
        .verify(asset, &signature, true)
        .map_err(|error| format!("minisign verification failed: {error}"))
}

#[test]
fn committed_invalid_updater_corpus_matches_production_boundaries() {
    use tauri_plugin_updater::{RemoteRelease, RemoteReleaseInner};

    let root = fixture_root().join("updater");
    let invalid_root = root.join("invalid");
    let cases: FixtureCases = serde_json::from_slice(
        &std::fs::read(invalid_root.join("cases.json")).expect("read updater fixture cases"),
    )
    .expect("parse updater fixture cases");
    let valid_release: RemoteRelease = serde_json::from_slice(
        &std::fs::read(root.join("valid").join("latest.json")).expect("read valid updater fixture"),
    )
    .expect("parse valid updater fixture");
    let valid_platforms = match &valid_release.data {
        RemoteReleaseInner::Static { platforms } => platforms,
        RemoteReleaseInner::Dynamic(_) => panic!("valid updater fixture must use static format"),
    };
    let public_key = std::fs::read_to_string(root.join("valid").join("test-public-key.txt"))
        .expect("read updater fixture public key");
    let asset = std::fs::read(root.join("valid").join("fixture-asset.bin"))
        .expect("read updater fixture asset");
    let mut covered_stages = std::collections::BTreeSet::new();

    for case in cases.cases {
        let bytes = std::fs::read(invalid_root.join(&case.path))
            .unwrap_or_else(|error| panic!("read updater fixture {}: {error}", case.id));
        let parsed = serde_json::from_slice::<RemoteRelease>(&bytes);
        covered_stages.insert(case.expected_stage.clone());

        match case.expected_stage.as_str() {
            "parse" => {
                assert!(parsed.is_err(), "{} should fail release parsing", case.id);
            }
            "target-lookup" => {
                let release =
                    parsed.unwrap_or_else(|error| panic!("{} should parse: {error}", case.id));
                let platforms = match &release.data {
                    RemoteReleaseInner::Static { platforms } => platforms,
                    RemoteReleaseInner::Dynamic(_) => {
                        panic!("{} must use static updater format", case.id)
                    }
                };
                let missing_targets = valid_platforms
                    .keys()
                    .filter(|target| !platforms.contains_key(*target))
                    .collect::<Vec<_>>();
                assert_eq!(
                    missing_targets.len(),
                    1,
                    "{} should omit exactly one valid fixture target",
                    case.id
                );
                let missing_target = missing_targets[0];
                assert!(release.download_url(missing_target).is_err());
                assert!(release.signature(missing_target).is_err());
            }
            "signature" => {
                let release =
                    parsed.unwrap_or_else(|error| panic!("{} should parse: {error}", case.id));
                let platforms = match &release.data {
                    RemoteReleaseInner::Static { platforms } => platforms,
                    RemoteReleaseInner::Dynamic(_) => {
                        panic!("{} must use static updater format", case.id)
                    }
                };
                assert_eq!(
                    platforms.keys().collect::<std::collections::BTreeSet<_>>(),
                    valid_platforms
                        .keys()
                        .collect::<std::collections::BTreeSet<_>>(),
                    "{} must reach signature validation with every fixture target present",
                    case.id
                );
                let invalid_targets = valid_platforms
                    .keys()
                    .filter(|target| {
                        release
                            .download_url(target)
                            .expect("invalid-signature fixture target URL");
                        let signature = release
                            .signature(target)
                            .expect("static updater target signature");
                        verify_fixture_updater_signature(&asset, signature, &public_key).is_err()
                    })
                    .collect::<Vec<_>>();
                assert_eq!(
                    invalid_targets.len(),
                    1,
                    "{} should contain exactly one signature rejected by the updater boundary",
                    case.id
                );
            }
            stage => panic!("unexpected updater fixture stage {stage} for {}", case.id),
        }
    }

    assert_eq!(
        covered_stages,
        std::collections::BTreeSet::from([
            "parse".to_string(),
            "signature".to_string(),
            "target-lookup".to_string(),
        ])
    );
}

#[test]
fn committed_request_log_fixture_has_expected_scale_and_hash() {
    let root = fixture_root().join("request-logs");
    let bytes =
        std::fs::read(root.join("request-logs-10000.jsonl")).expect("read request log fixture");
    let metadata: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("metadata.json")).expect("read request log metadata"),
    )
    .expect("parse request log metadata");
    assert_eq!(metadata["rowCount"], 10_000);
    assert_eq!(metadata["sha256"], sha256_hex(&bytes));

    let mut count = 0_usize;
    let mut sessions = std::collections::BTreeSet::new();
    let mut has_failover = false;
    let mut has_interrupted = false;
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let row: serde_json::Value = serde_json::from_slice(line).expect("parse request log row");
        count += 1;
        sessions.insert(
            row["session_id"]
                .as_str()
                .expect("fixture session id")
                .to_string(),
        );
        has_failover |= row["has_failover"].as_bool() == Some(true);
        has_interrupted |= row["is_interrupted"].as_bool() == Some(true);
    }
    assert_eq!(count, 10_000);
    assert!(sessions.len() <= 12);
    assert!(has_failover);
    assert!(has_interrupted);
}

fn assert_shared_event_fixture<T: Serialize>(payload: &T, fixture: &str) {
    let expected: serde_json::Value =
        serde_json::from_str(fixture).expect("parse shared application event fixture");
    let actual = serde_json::to_value(payload).expect("serialize production event payload");
    assert_eq!(
        actual, expected,
        "production event serialization no longer matches the shared frontend fixture"
    );
}

#[test]
fn committed_application_event_fixtures_match_production_serialization() {
    let startup = crate::app::startup_state::AppStartupStatus {
        running: false,
        current_stage: crate::app::startup_state::AppStartupStage::Ready,
        failed_stage: None,
        error_message: None,
        can_retry: false,
    };
    assert_shared_event_fixture(
        &startup,
        include_str!("../../src/services/app/__fixtures__/startupStatus/ready.json"),
    );

    let heartbeat = crate::app::heartbeat_watchdog::heartbeat_payload(1_750_000_000_000);
    assert_shared_event_fixture(
        &heartbeat,
        include_str!("../../src/services/app/__fixtures__/heartbeat.json"),
    );

    let notice = crate::app::notice::build(
        crate::app::notice::NoticeLevel::Info,
        Some("Fixture".to_string()),
        "Synthetic compatibility fixture notice".to_string(),
    )
    .expect("build fixture notice through production validation");
    assert_shared_event_fixture(
        &notice,
        include_str!("../../src/services/app/__fixtures__/notice.json"),
    );
}
