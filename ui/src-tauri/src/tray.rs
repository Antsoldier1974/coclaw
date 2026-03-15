use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, Manager, WindowEvent,
};

pub fn init(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().expect("no default icon"))
        .tooltip("CoClaw")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { .. } = event {
                if let Some(win) = tray.app_handle().get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        // 默认：关闭窗口时最小化到托盘
        // TODO: 后续通过 tauri-plugin-store 读取用户偏好
        let _ = window.hide();
        api.prevent_close();
    }
}
