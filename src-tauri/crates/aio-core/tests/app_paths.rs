use aio_core::{plugin_id_path_segment, AppPathOverrides, AppPathRoots, AppPaths};
use std::path::{Path, PathBuf};

fn roots(home: &Path, resources: &Path) -> AppPathRoots {
    AppPathRoots {
        platform_home: home.to_path_buf(),
        resource_dir: resources.to_path_buf(),
    }
}

#[test]
fn default_paths_are_created_below_platform_home() {
    let home = tempfile::tempdir().expect("home tempdir");
    let resources = tempfile::tempdir().expect("resource tempdir");

    let paths = AppPaths::resolve(
        roots(home.path(), resources.path()),
        AppPathOverrides::default(),
    )
    .expect("resolve default paths");

    assert_eq!(paths.home(), home.path());
    assert_eq!(paths.data_dir(), home.path().join(".aio-coding-hub"));
    assert_eq!(paths.resource_dir(), resources.path());
    assert!(paths.data_dir().is_dir());
}

#[test]
fn absolute_test_home_has_highest_precedence() {
    let platform_home = tempfile::tempdir().expect("platform home");
    let override_home = tempfile::tempdir().expect("override home");
    let test_home = tempfile::tempdir().expect("test home");
    let resources = tempfile::tempdir().expect("resource tempdir");

    let paths = AppPaths::resolve(
        roots(platform_home.path(), resources.path()),
        AppPathOverrides {
            test_home: Some(test_home.path().to_path_buf()),
            home_dir: Some(override_home.path().to_path_buf()),
            dotdir_name: None,
        },
    )
    .expect("resolve test override");

    assert_eq!(paths.home(), test_home.path());
}

#[test]
fn relative_test_home_is_ignored_but_relative_home_override_is_preserved() {
    let current = std::env::current_dir().expect("current directory");
    let relative_parent = tempfile::tempdir_in(&current).expect("relative home parent");
    let relative_home = relative_parent
        .path()
        .strip_prefix(&current)
        .expect("tempdir below current directory")
        .to_path_buf();
    let platform_home = tempfile::tempdir().expect("platform home");
    let resources = tempfile::tempdir().expect("resource tempdir");

    let paths = AppPaths::resolve(
        roots(platform_home.path(), resources.path()),
        AppPathOverrides {
            test_home: Some(PathBuf::from("ignored-relative-test-home")),
            home_dir: Some(relative_home.clone()),
            dotdir_name: Some(".relative-home".to_string()),
        },
    )
    .expect("resolve relative home override");

    assert_eq!(paths.home(), relative_home);
    assert_eq!(paths.data_dir(), paths.home().join(".relative-home"));
    assert!(paths.data_dir().is_dir());
}

#[test]
fn dotdir_override_accepts_safe_names_and_rejects_unsafe_names() {
    let home = tempfile::tempdir().expect("home tempdir");
    let resources = tempfile::tempdir().expect("resource tempdir");
    let roots = roots(home.path(), resources.path());

    let safe = AppPaths::resolve(
        roots.clone(),
        AppPathOverrides {
            dotdir_name: Some("  .aio-c1_test  ".to_string()),
            ..AppPathOverrides::default()
        },
    )
    .expect("safe dotdir");
    assert_eq!(safe.data_dir(), home.path().join(".aio-c1_test"));

    for unsafe_name in ["", ".", "..", "aio", "../escape", ".bad/name", ".bad\\name"] {
        let paths = AppPaths::resolve(
            roots.clone(),
            AppPathOverrides {
                dotdir_name: Some(unsafe_name.to_string()),
                ..AppPathOverrides::default()
            },
        )
        .expect("unsafe override falls back to default");
        assert_eq!(paths.data_dir(), home.path().join(".aio-coding-hub"));
    }
}

#[test]
fn persisted_and_resource_subpaths_are_owned_by_app_paths() {
    let home = tempfile::tempdir().expect("home tempdir");
    let resources = tempfile::tempdir().expect("resource tempdir");
    let paths = AppPaths::resolve(
        roots(home.path(), resources.path()),
        AppPathOverrides::default(),
    )
    .expect("resolve paths");
    let data = home.path().join(".aio-coding-hub");

    assert_eq!(paths.database_file(), data.join("aio-coding-hub.db"));
    assert_eq!(
        paths.database_optimize_stamp(),
        data.join("db_optimize.stamp")
    );
    assert_eq!(paths.settings_file(), data.join("settings.json"));
    assert_eq!(paths.logs_dir(), data.join("logs"));
    assert_eq!(paths.skills_root(), data.join("skills"));
    assert_eq!(paths.skill_repos_root(), data.join("skill-repos"));
    assert_eq!(paths.mcp_sync_root("claude"), data.join("mcp-sync/claude"));
    assert_eq!(paths.model_prices_dir(), data.join("model-prices"));
    assert_eq!(paths.plugins_root(), data.join("plugins"));
    assert_eq!(
        paths.plugins_installed_dir(),
        data.join("plugins/installed")
    );
    assert_eq!(paths.plugins_cache_dir(), data.join("plugins/cache"));
    assert_eq!(paths.plugins_data_dir(), data.join("plugins/data"));
    assert_eq!(paths.plugins_logs_dir(), data.join("plugins/logs"));
    assert_eq!(
        paths
            .plugin_data_dir("community.prompt-helper")
            .expect("valid plugin data path"),
        data.join("plugins/data/community.prompt-helper")
    );
    assert_eq!(
        paths.official_plugins_bundled_root(),
        resources.path().join("resources/plugins/official")
    );
    assert_eq!(
        paths.official_plugins_dev_root(),
        resources.path().join("plugins/official")
    );
}

#[test]
fn plugin_id_segments_reject_traversal_and_noncanonical_values() {
    for invalid in [
        "",
        ".",
        "..",
        "../evil",
        "official/evil",
        "official\\evil",
        "official..evil",
        "Official.plugin",
    ] {
        assert!(
            plugin_id_path_segment(invalid).is_err(),
            "accepted {invalid:?}"
        );
    }

    assert_eq!(
        plugin_id_path_segment("community.prompt-helper").expect("valid plugin id"),
        "community.prompt-helper"
    );
    assert_eq!(
        plugin_id_path_segment(" plugin.id ").expect("trimmed plugin id"),
        "plugin.id"
    );
}
