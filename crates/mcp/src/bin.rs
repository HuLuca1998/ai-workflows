//! 独立跑一个系统 MCP。
//!
//! 桌面应用会在进程内起同一个服务（那才是产品形态）。这个二进制的用处是：
//! 用 MCP Inspector 之类的工具调试、在 CI 里做端到端验证、
//! 以及在没装桌面壳的机器上把 Web 形态的数据库接出去。
//!
//! ```
//! aiwf-mcp --db ~/Library/Application\ Support/aiwf/aiwf.sqlite
//! ```

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let db_path = arg(&args, "--db").map_or_else(
        || {
            std::env::temp_dir()
                .join("aiwf-devserver")
                .join("aiwf.sqlite")
        },
        std::path::PathBuf::from,
    );

    let data_dir = arg(&args, "--data-dir").map_or_else(
        || {
            db_path
                .parent()
                .map_or_else(std::env::temp_dir, std::path::Path::to_path_buf)
        },
        std::path::PathBuf::from,
    );

    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // 先开一次：建表与迁移在这里做完，工作线程各自开连接时就只是连上去。
    // 让 8 个线程同时跑迁移会撞锁
    // open_workspace：这一次是初始化工作区，工作线程只是再开一条连接
    if let Err(error) = aiwf_store::Store::open_workspace(&db_path) {
        eprintln!("打不开数据库 {}：{error}", db_path.display());
        std::process::exit(1);
    }

    let mut config = match aiwf_core_api::mcp_config::load_or_create(&data_dir) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    if let Some(port) = arg(&args, "--port").and_then(|text| text.parse().ok()) {
        config.port = port;
    }

    let handle = match aiwf_mcp::start(&data_dir, db_path.clone(), config) {
        Ok(handle) => handle,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };

    println!("aiwf MCP 已启动");
    println!("  端点：{}", handle.plain_url());
    println!("  带令牌：{}", handle.url());
    println!("  数据库：{}", db_path.display());
    println!("  工具：{} 个", aiwf_mcp::catalog::tools().len());
    println!();
    println!("接入 Claude Code：");
    println!(
        "  {}",
        aiwf_core_api::mcp_clients::install_command(
            aiwf_core_api::mcp_clients::Client::Claude,
            handle.port,
            &handle.token
        )
        .display()
    );
    println!("接入 Codex：");
    println!(
        "  {}",
        aiwf_core_api::mcp_clients::install_command(
            aiwf_core_api::mcp_clients::Client::Codex,
            handle.port,
            &handle.token
        )
        .display()
    );

    // 工作线程在后台跑，主线程停在这儿等 Ctrl-C
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

fn arg(args: &[String], flag: &str) -> Option<String> {
    let index = args.iter().position(|a| a == flag)?;
    args.get(index + 1).cloned()
}
