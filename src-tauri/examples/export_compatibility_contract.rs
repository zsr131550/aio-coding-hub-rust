fn main() {
    let output_path = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: export_compatibility_contract <absolute-output-path>");
        std::process::exit(2);
    });
    if let Err(error) = aio_coding_hub_lib::export_compatibility_contract(output_path) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
