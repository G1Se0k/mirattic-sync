use keyring::{Entry, Error};

const KEYCHAIN_SERVICE: &str = "com.mirattic.sync";
const KEYCHAIN_ACCOUNT: &str = "refresh-token";

fn entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

// The Mirattic refresh token lives in the OS keychain, never in webview storage.
// Error messages never include the token value.
#[tauri::command]
fn refresh_token_load() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn refresh_token_save(token: Option<String>) -> Result<(), String> {
    let entry = entry()?;
    match token {
        Some(t) => entry.set_password(&t).map_err(|e| e.to_string()),
        None => match entry.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![refresh_token_load, refresh_token_save])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
