fn configure_windows_resource_compiler() {
    if std::env::var_os("RC").is_some() || !cfg!(windows) {
        return;
    }

    let Some(kits_bin) = std::env::var_os("ProgramFiles(x86)")
        .map(std::path::PathBuf::from)
        .map(|root| root.join("Windows Kits").join("10").join("bin"))
    else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(kits_bin) else {
        return;
    };
    let mut versions = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    versions.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    for version in versions {
        for host_arch in ["x64", "x86"] {
            let candidate = version.join(host_arch).join("rc.exe");
            if candidate.is_file() {
                std::env::set_var("RC", candidate);
                return;
            }
        }
    }
}

fn link_tauri_resources_into_windows_auxiliary_targets() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").ok();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").ok();
    if target_os.as_deref() != Some("windows") || target_env.as_deref() != Some("msvc") {
        return;
    }

    // tauri-build normally links this resource only into binary targets. Tests
    // and examples import the same desktop APIs, so they need the Common Controls
    // v6 activation manifest too or they can fail before Rust's entry point runs.
    let resource =
        std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("resource.lib");
    assert!(
        resource.is_file(),
        "tauri-build did not produce the expected Windows resource library: {}",
        resource.display()
    );
    println!(
        "cargo:rustc-link-search=native={}",
        resource.parent().expect("resource parent").display()
    );
    println!("cargo:rustc-link-arg-tests={}", resource.display());
    println!("cargo:rustc-link-arg-examples={}", resource.display());
}

fn main() {
    configure_windows_resource_compiler();
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(windows)
            .plugin("benchmark", tauri_build::InlinedPlugin::new()),
    )
    .expect("failed to run Tauri build helpers");
    link_tauri_resources_into_windows_auxiliary_targets();
}
