// 关掉 Windows 上的额外控制台窗口；macOS 无影响，保留以便日后跨平台。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aiwf_desktop_lib::run()
}
