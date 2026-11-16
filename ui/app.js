'use strict';

const T = window.__TAURI__;
const invoke = T.core.invoke;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const env = $('#env'), stage = $('#stage');
const OS = navigator.userAgent.includes('Windows') ? 'win' : 'mac';
const state = { file: null, mode: 'pass', busy: false, contacts: [], recipients: new Set(), lastOut: null };
const COLORS = ['#5B7FD6', '#3E9C88', '#B0785A', '#8B67C9', '#C2556E', '#4C8FB5'];

/* ---------- platform text ---------- */
document.body.dataset.os = OS;
const STORE = OS === 'mac' ? 'Связке ключей' : 'диспетчере учётных данных';
$('.k-open').textContent = OS === 'mac' ? '⌘O' : 'Ctrl+O';
$('#revealBtn').textContent = OS === 'mac' ? 'Показать в Finder' : 'Показать в проводнике';
$('#storeNote').textContent = 'Секретная часть хранится в ' + STORE;
$('#keyStoreNote').textContent = 'Пароль не нужен, ключ уже в ' + STORE;

/* ---------- wax blob ---------- */
(function wax() {
  const cx = 125, cy = 114, n = 22; let d = '';
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2, r = 21 + (i % 2 ? 1.6 : -0.4) + Math.sin(i * 1.7) * .9;
    d += (i ? ' L' : 'M') + (cx + Math.cos(a) * r).toFixed(1) + ' ' + (cy + Math.sin(a) * r).toFixed(1);
  }
  $('#waxpath').setAttribute('d', d + 'Z');
})();

/* ---------- helpers ---------- */
function fmtSize(b) {
  if (b < 1024) return b + ' Б';
  if (b < 1048576) return Math.round(b / 1024) + ' КБ';
  if (b < 1073741824) return (b / 1048576).toFixed(1).replace('.', ',') + ' МБ';
  return (b / 1073741824).toFixed(2).replace('.', ',') + ' ГБ';
}
function extOf(n) { const m = n.replace(/\.age$/i, '').match(/\.([a-z0-9]{1,4})$/i); return m ? m[1].toUpperCase() : 'ФАЙЛ'; }
function shortKey(k, a = 14) { return k.slice(0, a) + '…' + k.slice(-6); }
function errMsg(e) { return (e && e.message) || String(e); }
function esc(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function colorFor(key) { let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }

let tt;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 2600); }

/* ---------- panes ---------- */
function pane(name) {
  $$('[data-pane]').forEach(p => p.hidden = p.dataset.pane !== name);
  stage.classList.toggle('drop-target', name === 'idle');
  stage.tabIndex = name === 'idle' ? 0 : -1;
}
function currentPane() { return $$('[data-pane]').find(p => !p.hidden)?.dataset.pane; }
function bind() {
  $$('[data-bind="name"]').forEach(e => e.textContent = state.file.name);
  $$('[data-bind="size"]').forEach(e => e.textContent = fmtSize(state.file.size));
  $('#ext').textContent = extOf(state.file.name);
}

function tab(t) {
  $$('[data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
  $('#v-main').classList.toggle('on', t === 'main');
  $('#v-keys').classList.toggle('on', t === 'keys');
  if (t === 'keys') loadKey();
}
$$('[data-tab]').forEach(b => b.addEventListener('click', () => tab(b.dataset.tab)));

/* ---------- loading a file ---------- */
async function load(path) {
  if (state.busy) return;
  tab('main');
  let info;
  try { info = await invoke('inspect', { path }); }
  catch (e) { reset(); toast(errMsg(e)); return; }
  clearForms();
  state.file = info;
  bind();
  if (info.kind === 'plain') {
    env.dataset.s = 'loaded';
    pane('compose');
    setMode(state.mode);
    setTimeout(() => (state.mode === 'pass' ? $('#p1') : $('#seal')).focus(), 60);
  } else {
    env.dataset.s = 'sealed';
    $$('[data-openmode]').forEach(p => p.hidden = p.dataset.openmode !== info.kind);
    $('#openBtn').hidden = info.kind === 'foreign';
    pane('open');
    setTimeout(() => (info.kind === 'pass' ? $('#op') : $('#openBtn')).focus(), 60);
  }
}

function clearForms() {
  ['#p1', '#p2', '#op'].forEach(s => { $(s).value = ''; $(s).type = 'password'; $(s).classList.remove('bad'); });
  $$('[data-act="peek"]').forEach(b => b.textContent = 'Показать');
  ['#openErr', '#mismatch', '#composeErr'].forEach(s => $(s).textContent = '');
  $('#trash').checked = false;
  strength(); validate();
}

function reset() {
  if (state.busy) return;
  state.file = null;
  clearForms();
  dragOn(false);
  env.dataset.s = 'empty';
  pane('idle');
  stage.focus();
}

async function pickFile() {
  if (state.busy) return;
  const path = await T.dialog.open({ multiple: false, directory: false, title: 'Выберите файл' });
  if (path) load(path);
}

/* ---------- encrypt mode ---------- */
function setMode(m) {
  state.mode = m;
  $$('[data-mode]').forEach(b => b.setAttribute('aria-checked', b.dataset.mode === m));
  $$('[data-modepane]').forEach(p => p.hidden = p.dataset.modepane !== m);
  validate();
}
$$('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('.seg').addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const m = state.mode === 'pass' ? 'key' : 'pass'; setMode(m); $(`[data-mode="${m}"]`).focus();
});

function strength() {
  const v = $('#p1').value; let s = 0;
  if (v.length >= 8) s++;
  if (v.length >= 12) s++;
  if (v.length >= 16 || (/[-\s]/.test(v) && v.length >= 14)) s++;
  if ((/[A-ZА-ЯЁ]/.test(v) && /[0-9]/.test(v)) || /[^\p{L}\p{N}\s-]/u.test(v)) s++;
  s = v ? Math.max(1, Math.min(4, s)) : 0;
  $('#meter').dataset.l = s;
  $('#strength').textContent = ['Несколько слов надёжнее значков', 'Слабый: подберут за минуты', 'Средний: лучше добавить слово', 'Хороший', 'Надёжный'][s];
}
function validate() {
  let ok;
  if (state.mode === 'pass') {
    const a = $('#p1').value, b = $('#p2').value, mm = b && a !== b;
    $('#p2').classList.toggle('bad', !!mm);
    $('#mismatch').textContent = mm ? 'Пароли не совпадают' : '';
    ok = a.length > 0 && a === b;
  } else ok = state.recipients.size > 0;
  $('#seal').disabled = !ok;
  $('#seal').textContent = state.mode === 'key' && state.recipients.size > 1 ? `Запечатать для ${state.recipients.size}` : 'Запечатать';
}
$('#p1').addEventListener('input', () => { strength(); validate(); });
$('#p2').addEventListener('input', validate);

const WORDS = ['кедр', 'маяк', 'сова', 'полынь', 'ветер', 'гранит', 'лодка', 'иней', 'компас', 'ольха', 'шторм', 'янтарь', 'фонарь', 'брусника', 'сокол', 'туман',
  'вереск', 'причал', 'клевер', 'зенит', 'омут', 'пихта', 'роса', 'сирень', 'тундра', 'улей', 'хвоя', 'чайка', 'ясень', 'бархан', 'гавань', 'долото'];
function gen() {
  const r = new Uint32Array(6); crypto.getRandomValues(r);
  const p = [0, 1, 2, 3, 4].map(i => WORDS[r[i] % WORDS.length]).join('-') + '-' + (r[5] % 90 + 10);
  $('#p1').value = p; $('#p2').value = p; $('#p1').type = 'text';
  $('#p1').nextElementSibling.textContent = 'Скрыть';
  strength(); validate();
  toast('Пароль придуман. Сохраните его в менеджере паролей');
}

/* ---------- recipients ---------- */
function renderPeople() {
  const list = state.contacts;
  $('#people').innerHTML = list.length ? list.map(c => `
    <button class="person" role="checkbox" aria-checked="${state.recipients.has(c.key)}" data-key="${esc(c.key)}" type="button">
      <span class="avatar" style="background:${colorFor(c.key)}">${esc([...c.name][0].toUpperCase())}</span>
      <span class="who"><b>${esc(c.name)}</b><code>${esc(shortKey(c.key))}</code></span>
      <span class="check"></span>
    </button>`).join('')
    : '<div class="empty">Получателей пока нет. Добавьте ключ того, кому хотите отправить файл</div>';
  $('#contacts').innerHTML = list.length ? list.map(c => `
    <div class="person">
      <span class="avatar" style="background:${colorFor(c.key)}">${esc([...c.name][0].toUpperCase())}</span>
      <span class="who"><b>${esc(c.name)}</b><code>${esc(shortKey(c.key, 22))}</code></span>
      <button class="x" data-remove="${esc(c.key)}" aria-label="Удалить ${esc(c.name)}" title="Удалить">×</button>
    </div>`).join('')
    : '<div class="empty">Здесь будут ключи людей, для которых вы шифруете файлы</div>';
}
$('#people').addEventListener('click', e => {
  const b = e.target.closest('.person'); if (!b) return;
  const k = b.dataset.key;
  state.recipients.has(k) ? state.recipients.delete(k) : state.recipients.add(k);
  renderPeople(); validate();
  $(`#people [data-key="${CSS.escape(k)}"]`)?.focus();
});
$('#contacts').addEventListener('click', async e => {
  const b = e.target.closest('[data-remove]'); if (!b) return;
  const name = state.contacts.find(c => c.key === b.dataset.remove)?.name;
  try {
    state.contacts = await invoke('remove_contact', { key: b.dataset.remove });
    state.recipients.delete(b.dataset.remove);
    renderPeople(); validate(); toast(`${name} удалён из получателей`);
  } catch (err) { toast(errMsg(err)); }
});
async function loadContacts() {
  try { state.contacts = await invoke('list_contacts'); } catch (e) { toast(errMsg(e)); }
  if (state.contacts.length === 1) state.recipients.add(state.contacts[0].key); // единственного выбираем сразу
  renderPeople();
}

/* ---------- my key ---------- */
let keyLoaded = false;
async function loadKey() {
  if (keyLoaded) return;
  try { $('#mykey').textContent = await invoke('my_key'); keyLoaded = true; }
  catch (e) { $('#mykey').textContent = errMsg(e); }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

/* add contact */
function showAdd(on) {
  $('#addform').hidden = !on; $('#addBtn').hidden = on;
  $('#addErr').textContent = '';
  if (on) { $('#cName').value = ''; $('#cKey').value = ''; $('#cName').focus(); }
}
$('#addform').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const key = $('#cKey').value.trim();
    state.contacts = await invoke('add_contact', { name: $('#cName').value, key });
    state.recipients.add(key);
    renderPeople(); validate(); showAdd(false);
    toast('Получатель добавлен');
  } catch (err) { $('#addErr').textContent = errMsg(err); }
});

/* ---------- sealing / opening ---------- */
let unlistenProgress = null;
async function withProgress(kind, job) {
  state.busy = true;
  pane('working');
  $('#workTitle').textContent = kind === 'seal' ? 'Запечатываем…' : 'Вскрываем…';
  $('#workNote').textContent = kind === 'seal' && state.mode === 'pass'
    ? 'Пароль укрепляется, это занимает пару секунд'
    : kind === 'seal' ? 'Ключ шифрования создаётся заново для каждого файла' : 'Проверяем, что файл не изменён';
  $('#bar').style.width = '0';
  unlistenProgress = await T.event.listen('progress', e => { $('#bar').style.width = e.payload + '%'; });
  try {
    // Анимация конверта длится ~1 с: не даём экрану мигнуть на мелких файлах.
    const [out] = await Promise.all([job(), sleep(1100)]);
    $('#bar').style.width = '100%';
    return out;
  } finally {
    unlistenProgress?.(); unlistenProgress = null;
    state.busy = false;
  }
}

async function seal() {
  if ($('#seal').disabled || state.busy) return;
  env.dataset.s = 'sealed';
  const args = {
    path: state.file.path,
    passphrase: state.mode === 'pass' ? $('#p1').value : null,
    recipients: state.mode === 'key' ? [...state.recipients] : [],
    trashOriginal: $('#trash').checked,
  };
  try {
    const out = await withProgress('seal', () => invoke('encrypt', args));
    const names = state.contacts.filter(c => state.recipients.has(c.key)).map(c => c.name);
    showDone(out, 'Запечатано',
      state.mode === 'pass' ? 'Открыть файл можно только с паролем' : 'Открыть смогут: ' + names.join(', '),
      args.trashOriginal ? ' · оригинал в корзине' : ' · рядом с оригиналом', 'Запечатать ещё');
  } catch (e) {
    env.dataset.s = 'loaded'; pane('compose');
    $('#composeErr').textContent = errMsg(e);
  }
}

async function openEnvelope() {
  if (state.busy || state.file.kind === 'foreign') return;
  const pass = state.file.kind === 'pass' ? $('#op').value : null;
  if (state.file.kind === 'pass' && !pass) { $('#op').focus(); return; }
  env.dataset.s = 'opened';
  try {
    const out = await withProgress('open', () => invoke('decrypt', { path: state.file.path, passphrase: pass }));
    showDone(out, 'Вскрыто', 'Файл расшифрован и лежит рядом с конвертом', ' · подлинность проверена', 'Готово');
  } catch (e) {
    pane('open');
    if (e && e.code === 'wrong_password') {
      $('#op').classList.add('bad');
      env.dataset.s = 'sealed'; void env.getBoundingClientRect(); env.dataset.s = 'broken';
      $('#op').select();
    } else env.dataset.s = 'sealed';
    $('#openErr').textContent = errMsg(e);
  }
}

function showDone(out, title, sub, meta, again) {
  state.lastOut = out.path;
  $('#doneTitle').textContent = title;
  $('#doneSub').textContent = sub;
  $('#outName').textContent = out.name;
  $('#outMeta').textContent = fmtSize(out.size) + meta;
  $('#renameNote').hidden = !out.renamed;
  $('#againBtn').textContent = again;
  ['#p1', '#p2', '#op'].forEach(s => $(s).value = ''); // пароль не держим в DOM дольше нужного
  pane('done'); $('#againBtn').focus();
}

$('#seal').addEventListener('click', seal);
$('#openBtn').addEventListener('click', openEnvelope);
$('#op').addEventListener('keydown', e => { if (e.key === 'Enter') openEnvelope(); });
$('#op').addEventListener('input', () => { $('#op').classList.remove('bad'); $('#openErr').textContent = ''; });
['#p1', '#p2'].forEach(s => $(s).addEventListener('keydown', e => { if (e.key === 'Enter') seal(); }));

/* ---------- drag & drop (native, gives real paths) ---------- */
function dragOn(on) {
  stage.classList.toggle('dragging', on);
  $('#idleTitle').textContent = on ? 'Отпустите, чтобы положить в конверт' : 'Перетащите файл сюда';
}
let preDrag = null;
T.webviewWindow.getCurrentWebviewWindow().onDragDropEvent(e => {
  const p = e.payload;
  if (state.busy) return;
  if (p.type === 'enter') {
    preDrag = { pane: currentPane(), env: env.dataset.s };
    tab('main'); pane('idle'); env.dataset.s = 'hover'; dragOn(true);
  } else if (p.type === 'leave') {
    dragOn(false);
    if (preDrag) { pane(preDrag.pane); env.dataset.s = preDrag.env; preDrag = null; }
  } else if (p.type === 'drop') {
    dragOn(false); preDrag = null;
    if (p.paths?.length > 1) toast('Пока по одному файлу за раз. Взяли первый');
    if (p.paths?.length) load(p.paths[0]); else reset();
  }
});

/* ---------- misc actions ---------- */
$('#pick').addEventListener('click', e => { e.stopPropagation(); pickFile(); });
stage.addEventListener('click', () => { if (stage.classList.contains('drop-target')) pickFile(); });
stage.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && stage.classList.contains('drop-target')) { e.preventDefault(); pickFile(); }
});
document.addEventListener('click', async e => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act;
  if (act === 'reset') reset();
  if (act === 'gen') gen();
  if (act === 'peek') {
    const i = a.previousElementSibling, show = i.type === 'password';
    i.type = show ? 'text' : 'password'; a.textContent = show ? 'Скрыть' : 'Показать'; i.focus();
  }
  if (act === 'reveal' && state.lastOut) invoke('reveal', { path: state.lastOut }).catch(err => toast(errMsg(err)));
  if (act === 'copy' && keyLoaded) toast(await copyText($('#mykey').textContent) ? 'Ключ скопирован' : 'Не удалось скопировать');
  if (act === 'add') showAdd(true);
  if (act === 'add-cancel') showAdd(false);
  if (act === 'tab-keys') { tab('keys'); showAdd(true); }
});

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); pickFile(); }
  if (e.key === 'Escape') {
    if (!$('#addform').hidden) return showAdd(false);
    if (state.file && !state.busy) reset();
  }
});
document.addEventListener('contextmenu', e => { if (!e.target.closest('input, code, .selectable')) e.preventDefault(); });

/* ---------- files opened from the OS ---------- */
async function takePending() {
  const path = await invoke('take_pending');
  if (path) load(path);
}
T.event.listen('open-file', () => takePending());

/* ---------- start ---------- */
pane('idle');
loadContacts().then(takePending);
