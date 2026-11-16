//! Конверт: шифрование файлов в формате age.
//!
//! Вся криптография — крейт `age`. Здесь только файлы, ключи и связь с интерфейсом.

use std::{
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    str::FromStr,
    sync::Mutex,
};

use age::secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const KEYRING_SERVICE: &str = "app.konvert.desktop";
const KEYRING_ACCOUNT: &str = "age-identity";

/* ---------- Errors ---------- */

/// Ошибка для интерфейса: `code` для логики, `message` для человека.
#[derive(Debug, Serialize)]
struct AppError {
    code: &'static str,
    message: String,
}

impl AppError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl From<io::Error> for AppError {
    fn from(e: io::Error) -> Self {
        let message = match e.kind() {
            io::ErrorKind::NotFound => "Файл не найден. Возможно, его переместили".to_string(),
            io::ErrorKind::PermissionDenied => "Нет доступа к файлу или папке".to_string(),
            _ => format!("Ошибка чтения или записи: {e}"),
        };
        AppError::new("io", message)
    }
}

impl From<age::DecryptError> for AppError {
    fn from(e: age::DecryptError) -> Self {
        use age::DecryptError::*;
        match e {
            DecryptionFailed | KeyDecryptionFailed => {
                AppError::new("wrong_password", "Пароль не подходит. Проверьте раскладку и Caps Lock")
            }
            NoMatchingKeys => AppError::new("not_for_you", "Конверт запечатан для другого ключа"),
            ExcessiveWork { .. } => AppError::new("too_slow", "Этот конверт слишком долго вскрывать: пароль защищён очень тяжёлыми настройками"),
            InvalidHeader | UnknownFormat => AppError::new("not_age", "Это не файл age или он повреждён"),
            InvalidMac => AppError::new("tampered", "Файл повреждён или изменён после шифрования"),
            Io(io) => io.into(),
            #[allow(unreachable_patterns)] // plugin-варианты есть только с фичей `plugin`
            other => AppError::new("decrypt", other.to_string()),
        }
    }
}

type Res<T> = Result<T, AppError>;

/* ---------- Identity (keychain) ---------- */

struct IdentityCache(Mutex<Option<age::x25519::Identity>>);

/// Личный ключ живёт в системном хранилище: Связка ключей на macOS,
/// диспетчер учётных данных на Windows. При первом обращении создаётся.
fn identity(app: &AppHandle) -> Res<age::x25519::Identity> {
    let cache = app.state::<IdentityCache>();
    let mut guard = cache.0.lock().unwrap();
    if let Some(id) = guard.as_ref() {
        return Ok(id.clone());
    }
    let keychain_err = |e: keyring::Error| AppError::new("keychain", format!("Нет доступа к хранилищу ключей: {e}"));
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(keychain_err)?;
    let id = match entry.get_password() {
        Ok(secret) => age::x25519::Identity::from_str(secret.trim())
            .map_err(|e| AppError::new("keychain", format!("Ключ в хранилище повреждён: {e}")))?,
        Err(keyring::Error::NoEntry) => {
            let id = age::x25519::Identity::generate();
            entry.set_password(id.to_string().expose_secret()).map_err(keychain_err)?;
            id
        }
        Err(e) => return Err(keychain_err(e)),
    };
    *guard = Some(id.clone());
    Ok(id)
}

/* ---------- Helpers ---------- */

/// Читатель, который сообщает интерфейсу прогресс в процентах.
struct Progress<'a, R> {
    inner: R,
    done: u64,
    total: u64,
    last: u8,
    app: &'a AppHandle,
}

impl<'a, R: Read> Progress<'a, R> {
    fn new(inner: R, total: u64, app: &'a AppHandle) -> Self {
        let _ = app.emit("progress", 0u8);
        Self { inner, done: 0, total: total.max(1), last: 0, app }
    }
}

impl<R: Read> Read for Progress<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.done += n as u64;
        let pct = ((self.done * 100) / self.total).min(100) as u8;
        if pct != self.last {
            self.last = pct;
            let _ = self.app.emit("progress", pct);
        }
        Ok(n)
    }
}

/// `отчёт.pdf.age` → (`отчёт`, `.pdf.age`). Скрытые файлы вида `.env` не режутся.
fn split_name(name: &str) -> (&str, &str) {
    match name.char_indices().skip(1).find(|&(_, c)| c == '.') {
        Some((i, _)) => name.split_at(i),
        None => (name, ""),
    }
}

/// Если файл уже есть, добавляет « (2)», « (3)»… Ничего не перезаписываем.
fn unique_path(wanted: PathBuf) -> (PathBuf, bool) {
    if !wanted.exists() {
        return (wanted, false);
    }
    let dir = wanted.parent().map(Path::to_path_buf).unwrap_or_default();
    let name = wanted.file_name().unwrap_or_default().to_string_lossy().to_string();
    let (stem, rest) = split_name(&name);
    for n in 2.. {
        let candidate = dir.join(format!("{stem} ({n}){rest}"));
        if !candidate.exists() {
            return (candidate, true);
        }
    }
    unreachable!()
}

fn file_name(p: &Path) -> String {
    p.file_name().unwrap_or_default().to_string_lossy().to_string()
}

/// Пишет во временный файл рядом и переименовывает только при успехе,
/// чтобы после ошибки не оставалось недописанных файлов.
fn write_atomically(dest: &Path, f: impl FnOnce(&mut BufWriter<File>) -> Res<()>) -> Res<()> {
    let tmp = dest.with_file_name(format!(".{}.konvert-partial", file_name(dest)));
    let result = (|| {
        let mut out = BufWriter::new(File::options().write(true).create_new(true).open(&tmp)?);
        f(&mut out)?;
        out.flush()?;
        out.get_ref().sync_all()?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            fs::rename(&tmp, dest)?;
            Ok(())
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// На macOS через NSFileManager: без запроса на управление Finder.
fn move_to_trash(p: &Path) -> Result<(), trash::Error> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(p)
    }
    #[cfg(not(target_os = "macos"))]
    trash::delete(p)
}

fn regular_file(path: &Path) -> Res<u64> {
    let meta = fs::metadata(path)?;
    if meta.is_dir() {
        return Err(AppError::new("folder", "Папки пока не поддерживаются. Сожмите папку в архив и перетащите архив"));
    }
    Ok(meta.len())
}

/* ---------- Commands ---------- */

#[derive(Serialize)]
struct FileInfo {
    path: String,
    name: String,
    size: u64,
    /// "plain" — обычный файл, "pass" — конверт с паролем,
    /// "key" — конверт для нашего ключа, "foreign" — для чужого ключа.
    kind: &'static str,
}

#[tauri::command]
async fn inspect(app: AppHandle, path: String) -> Res<FileInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let size = regular_file(&p)?;
        let name = file_name(&p);
        let reader = age::armor::ArmoredReader::new(BufReader::new(File::open(&p)?));
        let kind = match age::Decryptor::new(reader) {
            Err(_) => "plain",
            Ok(d) if d.is_scrypt() => "pass",
            Ok(d) => {
                let id = identity(&app)?;
                match d.decrypt(std::iter::once(&id as &dyn age::Identity)) {
                    Ok(_) => "key",
                    Err(_) => "foreign",
                }
            }
        };
        Ok(FileInfo { path, name, size, kind })
    })
    .await
    .map_err(|e| AppError::new("internal", e.to_string()))?
}

#[derive(Serialize)]
struct Outcome {
    path: String,
    name: String,
    size: u64,
    renamed: bool,
}

#[tauri::command]
async fn encrypt(
    app: AppHandle,
    path: String,
    passphrase: Option<String>,
    recipients: Vec<String>,
    trash_original: bool,
) -> Res<Outcome> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = PathBuf::from(&path);
        let total = regular_file(&src)?;

        let encryptor = match passphrase {
            Some(p) if !p.is_empty() => age::Encryptor::with_user_passphrase(SecretString::from(p)),
            _ => {
                let parsed = recipients
                    .iter()
                    .map(|r| {
                        age::x25519::Recipient::from_str(r.trim())
                            .map_err(|_| AppError::new("bad_key", format!("Неверный ключ получателя: {}", r.trim())))
                    })
                    .collect::<Res<Vec<_>>>()?;
                if parsed.is_empty() {
                    return Err(AppError::new("no_recipients", "Выберите хотя бы одного получателя"));
                }
                age::Encryptor::with_recipients(parsed.iter().map(|r| r as &dyn age::Recipient))
                    .map_err(|e| AppError::new("encrypt", e.to_string()))?
            }
        };

        let (dest, renamed) = unique_path(src.with_file_name(format!("{}.age", file_name(&src))));
        write_atomically(&dest, |out| {
            let mut writer = encryptor.wrap_output(out)?;
            let mut input = Progress::new(BufReader::new(File::open(&src)?), total, &app);
            io::copy(&mut input, &mut writer)?;
            writer.finish()?;
            Ok(())
        })?;

        if trash_original {
            move_to_trash(&src).map_err(|e| {
                AppError::new("trash", format!("Конверт готов, но оригинал не удалось убрать в корзину: {e}"))
            })?;
        }
        Ok(Outcome { size: fs::metadata(&dest)?.len(), name: file_name(&dest), path: dest.to_string_lossy().into(), renamed })
    })
    .await
    .map_err(|e| AppError::new("internal", e.to_string()))?
}

#[tauri::command]
async fn decrypt(app: AppHandle, path: String, passphrase: Option<String>) -> Res<Outcome> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = PathBuf::from(&path);
        let total = regular_file(&src)?;
        let input = Progress::new(BufReader::new(File::open(&src)?), total, &app);
        let decryptor = age::Decryptor::new(age::armor::ArmoredReader::new(input))?;

        let mut reader = if decryptor.is_scrypt() {
            let p = passphrase
                .filter(|p| !p.is_empty())
                .ok_or_else(|| AppError::new("need_password", "Введите пароль"))?;
            let id = age::scrypt::Identity::new(SecretString::from(p));
            decryptor.decrypt(std::iter::once(&id as &dyn age::Identity))?
        } else {
            let id = identity(&app)?;
            decryptor.decrypt(std::iter::once(&id as &dyn age::Identity))?
        };

        let name = file_name(&src);
        let plain_name = name
            .strip_suffix(".age")
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{name}.decrypted"));
        let (dest, renamed) = unique_path(src.with_file_name(plain_name));

        write_atomically(&dest, |out| {
            // Ошибка посреди потока значит, что данные изменены: age проверяет каждый блок.
            io::copy(&mut reader, out).map_err(|e| match e.kind() {
                io::ErrorKind::InvalidData => AppError::new("tampered", "Файл повреждён или изменён после шифрования"),
                _ => e.into(),
            })?;
            Ok(())
        })?;
        Ok(Outcome { size: fs::metadata(&dest)?.len(), name: file_name(&dest), path: dest.to_string_lossy().into(), renamed })
    })
    .await
    .map_err(|e| AppError::new("internal", e.to_string()))?
}

#[tauri::command]
async fn my_key(app: AppHandle) -> Res<String> {
    tauri::async_runtime::spawn_blocking(move || Ok(identity(&app)?.to_public().to_string()))
        .await
        .map_err(|e| AppError::new("internal", e.to_string()))?
}

/* ---------- Contacts ---------- */

#[derive(Serialize, Deserialize, Clone)]
struct Contact {
    name: String,
    key: String,
}

fn contacts_file(app: &AppHandle) -> Res<PathBuf> {
    let dir = app.path().app_config_dir().map_err(|e| AppError::new("config", e.to_string()))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("contacts.json"))
}

fn read_contacts(app: &AppHandle) -> Res<Vec<Contact>> {
    let f = contacts_file(app)?;
    if !f.exists() {
        return Ok(vec![]);
    }
    serde_json::from_slice(&fs::read(f)?).map_err(|e| AppError::new("config", format!("Список получателей повреждён: {e}")))
}

fn write_contacts(app: &AppHandle, list: &[Contact]) -> Res<()> {
    let f = contacts_file(app)?;
    let json = serde_json::to_vec_pretty(list).map_err(|e| AppError::new("config", e.to_string()))?;
    fs::write(f, json)?;
    Ok(())
}

#[tauri::command]
fn list_contacts(app: AppHandle) -> Res<Vec<Contact>> {
    read_contacts(&app)
}

#[tauri::command]
fn add_contact(app: AppHandle, name: String, key: String) -> Res<Vec<Contact>> {
    let key = key.trim().to_string();
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::new("bad_name", "Введите имя"));
    }
    age::x25519::Recipient::from_str(&key)
        .map_err(|_| AppError::new("bad_key", "Это не ключ age. Он начинается с age1 и состоит из 62 символов"))?;
    let mut list = read_contacts(&app)?;
    if list.iter().any(|c| c.key == key) {
        return Err(AppError::new("duplicate", "Этот ключ уже есть в списке"));
    }
    list.push(Contact { name, key });
    write_contacts(&app, &list)?;
    Ok(list)
}

#[tauri::command]
fn remove_contact(app: AppHandle, key: String) -> Res<Vec<Contact>> {
    let mut list = read_contacts(&app)?;
    list.retain(|c| c.key != key);
    write_contacts(&app, &list)?;
    Ok(list)
}

/* ---------- OS ---------- */

#[tauri::command]
fn reveal(path: String) -> Res<()> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    Command::new("open").arg("-R").arg(&path).spawn()?;
    #[cfg(target_os = "windows")]
    Command::new("explorer").arg(format!("/select,{path}")).spawn()?;
    #[cfg(target_os = "linux")]
    Command::new("xdg-open")
        .arg(Path::new(&path).parent().unwrap_or(Path::new("/")))
        .spawn()?;
    Ok(())
}

/* ---------- Files opened from the OS ---------- */

/// Файл, с которым приложение открыли (аргумент запуска, «Открыть в программе», Dock).
struct Pending(Mutex<Option<String>>);

#[tauri::command]
fn take_pending(state: tauri::State<Pending>) -> Option<String> {
    state.0.lock().unwrap().take()
}

#[allow(dead_code)] // используется только на macOS
fn hand_over(app: &AppHandle, path: String) {
    *app.state::<Pending>().0.lock().unwrap() = Some(path.clone());
    let _ = app.emit("open-file", path);
}

pub fn run() {
    let from_args = std::env::args().skip(1).find(|a| !a.starts_with('-') && Path::new(a).is_file());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(IdentityCache(Mutex::new(None)))
        .manage(Pending(Mutex::new(from_args)))
        .invoke_handler(tauri::generate_handler![
            inspect,
            encrypt,
            decrypt,
            my_key,
            list_contacts,
            add_contact,
            remove_contact,
            reveal,
            take_pending
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Konvert")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &_event {
                if let Some(path) = urls.iter().find_map(|u| u.to_file_path().ok()) {
                    hand_over(_app, path.to_string_lossy().into());
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_names() {
        assert_eq!(split_name("отчёт.pdf.age"), ("отчёт", ".pdf.age"));
        assert_eq!(split_name(".env"), (".env", ""));
        assert_eq!(split_name("README"), ("README", ""));
    }

    #[test]
    fn never_overwrites() {
        let dir = std::env::temp_dir().join(format!("konvert-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.txt.age");
        assert_eq!(unique_path(p.clone()), (p.clone(), false));
        fs::write(&p, b"x").unwrap();
        fs::write(dir.join("a (2).txt.age"), b"x").unwrap();
        assert_eq!(unique_path(p), (dir.join("a (3).txt.age"), true));
        fs::remove_dir_all(dir).unwrap();
    }

    /// Тот же путь, что в командах: шифруем паролем и ключом, читаем через ArmoredReader.
    #[test]
    fn roundtrip() {
        let data = vec![7u8; 200_000];

        let enc = age::Encryptor::with_user_passphrase(SecretString::from("кедр-маяк".to_string()));
        let mut out = vec![];
        let mut w = enc.wrap_output(&mut out).unwrap();
        w.write_all(&data).unwrap();
        w.finish().unwrap();
        let d = age::Decryptor::new(age::armor::ArmoredReader::new(&out[..])).unwrap();
        assert!(d.is_scrypt());
        let wrong = age::scrypt::Identity::new(SecretString::from("сова".to_string()));
        assert!(matches!(
            AppError::from(d.decrypt(std::iter::once(&wrong as &dyn age::Identity)).err().unwrap()).code,
            "wrong_password"
        ));
        let d = age::Decryptor::new(age::armor::ArmoredReader::new(&out[..])).unwrap();
        let right = age::scrypt::Identity::new(SecretString::from("кедр-маяк".to_string()));
        let mut back = vec![];
        d.decrypt(std::iter::once(&right as &dyn age::Identity)).unwrap().read_to_end(&mut back).unwrap();
        assert_eq!(back, data);

        let me = age::x25519::Identity::generate();
        let other = age::x25519::Identity::generate();
        let r = me.to_public();
        let enc = age::Encryptor::with_recipients(std::iter::once(&r as &dyn age::Recipient)).unwrap();
        let mut out = vec![];
        let mut w = enc.wrap_output(&mut out).unwrap();
        w.write_all(&data).unwrap();
        w.finish().unwrap();
        let d = age::Decryptor::new(&out[..]).unwrap();
        assert!(!d.is_scrypt());
        assert!(matches!(
            AppError::from(d.decrypt(std::iter::once(&other as &dyn age::Identity)).err().unwrap()).code,
            "not_for_you"
        ));
    }
}
