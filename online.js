'use strict';
/* ちんちん侍 — オンライン対戦（Firebase：匿名ログイン＋Realtime Database）
 * 進め方：部屋を作った人（ホスト）の端末がゲームを進めて判定し、CPUも動かす。
 * 参加者（ゲスト）は操作（言葉・タップ）だけを送り、状態と出来事を受け取って画面を動かす。
 *
 * データの置き場所（rooms/{部屋番号}）
 *   meta    : { host, status: 'lobby'|'play', at, roster?, set? }   … ホストだけが書く
 *   members : { uid: { name, hair, color, bonus, cs, at } }          … 自分の分だけ書く
 *   st      : 今の状態（ホストが上書きし続ける）
 *   ev      : 出来事の列（セリフ・矢印・切腹など。ホストが追加）
 *   acts    : ゲストの操作（ゲストが追加、ホストが読んだら消す）
 */
const FB_VER = '12.19.0';
const FB_BASE = `https://www.gstatic.com/firebasejs/${FB_VER}/`;
const MAX_MEMBERS = 6;
const HOST_AWAY_MS = 45000; // ホストの接続が切れたまま、これだけたったら参加者は抜ける

const Online = {
  p: null, ctx: null,
  code: null, role: null, offs: [], begun: false, members: {}, meta: null, me: null, awayTimer: null,
  chat: [], joinedAt: 0, lastSent: 0,

  configured() { const c = window.FIREBASE_CONFIG; return !!(c && c.apiKey && c.databaseURL); },
  start() {
    if (!this.configured()) return Promise.reject(new Error('NOCONFIG'));
    return this.p || (this.p = this._start().catch((e) => { this.p = null; throw e; }));
  },
  async _start() {
    const [A, Au, D] = await Promise.all(['app', 'auth', 'database'].map((n) => import(`${FB_BASE}firebase-${n}.js`)));
    const cfg = window.FIREBASE_CONFIG;
    const app = A.getApps().length ? A.getApp() : A.initializeApp(cfg);
    const auth = Au.getAuth(app);
    const db = D.getDatabase(app);
    if (cfg.emulator) { // テスト用（ローカルのエミュレーター）
      Au.connectAuthEmulator(auth, `http://${cfg.emulator}:9099`, { disableWarnings: true });
      D.connectDatabaseEmulator(db, cfg.emulator, 9000);
    }
    await auth.authStateReady();
    if (!auth.currentUser) await Au.signInAnonymously(auth);
    this.ctx = { D, db, uid: auth.currentUser.uid };
    this.watchConnection();
    return this.ctx;
  },
  /**
   * 通信が切れて戻ったとき（スマホで別のアプリやタブに切り替えると、裏のページの通信が切れることがある）
   *  - ホスト：「接続が切れた」印を消し、もう一度「切れたら印を付ける」を予約する
   *  - 参加者：待合室で一覧から外れていたら入り直す
   */
  watchConnection() {
    const { D, db, uid } = this.ctx;
    D.onValue(D.ref(db, '.info/connected'), async (s) => {
      if (s.val() !== true || !this.code) return;
      try {
        if (this.role === 'host') {
          await D.onDisconnect(this.r('meta/away')).set(D.serverTimestamp());
          await D.set(this.r('meta/away'), null);
        } else if (this.role === 'guest') {
          await D.onDisconnect(this.r(`members/${uid}`)).remove();
          if (!this.begun && this.me) {
            const mine = await D.get(this.r(`members/${uid}`));
            const meta = (await D.get(this.r('meta'))).val();
            if (!mine.exists() && meta && meta.status === 'lobby') await D.set(this.r(`members/${uid}`), { ...this.me, at: D.serverTimestamp() });
          }
        }
      } catch (e) { /* 次につながったときにまた試す */ }
    });
  },
  r(path) { return this.ctx.D.ref(this.ctx.db, `rooms/${this.code}${path ? '/' + path : ''}`); },
  listen(unsub) { this.offs.push(unsub); },
  detach() { this.offs.forEach((f) => { try { f(); } catch (e) { /* noop */ } }); this.offs = []; },

  /** 部屋を作る（4ケタの番号。空いている番号が見つかるまで試す） */
  async create(member) {
    const { D, uid } = this.ctx;
    for (let k = 0; k < 15; k++) {
      this.code = String(1000 + Math.floor(Math.random() * 9000));
      const res = await D.runTransaction(this.r('meta'), (cur) => (cur === null ? { host: uid, status: 'lobby', at: Date.now() } : undefined));
      if (!res.committed) continue;
      this.role = 'host';
      this.me = member;
      // ホストの通信が切れても部屋は消さず「接続が切れた」印を付ける（別のアプリに切り替えただけで部屋が消えないように）
      await D.onDisconnect(this.r('meta/away')).set(D.serverTimestamp());
      await D.set(this.r(`members/${uid}`), { ...member, at: D.serverTimestamp() });
      this.watchLobby();
      return this.code;
    }
    this.code = null;
    throw new Error('部屋を作れませんでした。もう一度試してください。');
  },
  /** 部屋に入る */
  async join(code, member) {
    const { D, uid } = this.ctx;
    this.code = code;
    const snap = await D.get(this.r('meta'));
    const meta = snap.val();
    if (!meta) { this.code = null; throw new Error('その番号の部屋はありません。'); }
    if (meta.status !== 'lobby') { this.code = null; throw new Error('その部屋はもう始まっています。'); }
    const ms = (await D.get(this.r('members'))).val() || {};
    if (Object.keys(ms).length >= MAX_MEMBERS && !ms[uid]) { this.code = null; throw new Error('その部屋は満員です（6人まで）。'); }
    this.role = 'guest';
    this.me = member;
    await D.onDisconnect(this.r(`members/${uid}`)).remove();
    await D.set(this.r(`members/${uid}`), { ...member, at: D.serverTimestamp() });
    this.watchLobby();
    return code;
  },
  /** 部屋の様子（参加者・開始）を見張る */
  watchLobby() {
    const { D } = this.ctx;
    this.chat = [];
    this.joinedAt = Date.now();
    renderChat();
    this.listen(D.onChildAdded(D.query(this.r('chat'), D.limitToLast(40)), (s) => this.onChat(s.val())));
    this.listen(D.onValue(this.r('members'), (s) => { this.members = s.val() || {}; this.onMembers(); }));
    this.listen(D.onValue(this.r('meta'), (s) => { this.meta = s.val(); this.onMeta(); }));
  },
  /** チャット・定型文を送る（連打しすぎないように少し間をあける） */
  sendChat(msg) {
    if (!this.code || !this.ctx || !this.me) return false;
    if (Date.now() - this.lastSent < 600) return false;
    this.lastSent = Date.now();
    const { D, uid } = this.ctx;
    D.push(this.r('chat'), { uid, name: this.me.name, ...msg, t: D.serverTimestamp() }).catch((e) => onMsg(errText(e)));
    return true;
  },
  /** その人の席（声と吹き出しの位置）：対戦中は席順、待合室では並び順 */
  seatOf(uid) {
    if (this.begun && this.meta && this.meta.roster) return this.meta.roster.findIndex((r) => r.uid === uid);
    return Math.min(MAX_MEMBERS - 1, this.memberList().findIndex((m) => m.uid === uid));
  },
  onChat(m) {
    if (!m) return;
    this.chat.push(m);
    if (this.chat.length > 40) this.chat.shift();
    renderChat();
    const mine = m.uid === this.ctx.uid;
    const fresh = !m.t || m.t > this.joinedAt - 3000; // 入る前の古い発言は音を鳴らさない
    const seat = this.seatOf(m.uid);
    if (this.begun && seat >= 0 && !mine) showBubble(seat, m.stamp || (m.text.length > 14 ? m.text.slice(0, 14) + '…' : m.text));
    if (!fresh || mine) return; // 自分の分は送ったときに鳴らしている
    if (m.stamp) {
      const sender = this.members[m.uid];
      if (seat >= 0 && $('netCharRecvChk').checked && (!sender || sender.cs !== false)) playStamp(seat, m.stamp);
    } else beep(880, 0.06, 'sine', 0.05);
  },
  /** 参加者を席順に（ホストが先、あとは入った順） */
  memberList() {
    const host = this.meta && this.meta.host;
    return Object.entries(this.members)
      .map(([uid, m]) => ({ uid, ...m }))
      .sort((a, b) => (a.uid === host ? -1 : b.uid === host ? 1 : (a.at || 0) - (b.at || 0)));
  },
  /** ホスト：席を決めて始める */
  async startGame() {
    const { D } = this.ctx;
    const ms = this.memberList();
    const total = Math.min(MAX_MEMBERS, Math.max(S.total, ms.length));
    const roster = Array.from({ length: total }, (_, i) => {
      const m = ms[i];
      if (m) return { uid: m.uid, name: m.name, cpu: 0, hair: m.hair, color: m.color, bonus: m.bonus || 0, cs: m.cs !== false };
      const pr = PROFILES[i];
      return { uid: '', name: pr.name.trim() || CPU_NAMES[(i - 1 + CPU_NAMES.length) % CPU_NAMES.length], cpu: 1, hair: pr.hair, color: pr.color, bonus: 0, cs: true };
    });
    const set = { code: this.code, rule: S.rule, cpu: S.cpu, diff: S.diff, safe: $('safeChk').checked, feint: $('feintChk').checked };
    await D.remove(this.r('ev'));
    await D.remove(this.r('acts'));
    await D.update(this.r('meta'), { status: 'play', roster, set });
  },
  /** 対戦の通信をつなぐ */
  beginNet(roster, set) {
    const { D, uid } = this.ctx;
    const me = roster.findIndex((r) => r.uid === uid);
    if (me < 0) { this.leave('席がありませんでした。'); return; }
    this.begun = true;
    if (this.role === 'host') {
      NET.push = () => { D.set(this.r('st'), netSnapshot()).catch(() => {}); };
      NET.emit = (e) => { D.push(this.r('ev'), e).catch(() => {}); };
      const seatOf = (u) => roster.findIndex((r) => r.uid === u && !r.cpu);
      this.listen(D.onChildAdded(this.r('acts'), (s) => {
        const a = s.val();
        D.remove(s.ref).catch(() => {});
        const seat = seatOf(a && a.uid);
        if (seat >= 0) netHostAct(seat, a);
      }));
    } else {
      NET.send = (a) => { D.push(this.r('acts'), { ...a, uid, t: D.serverTimestamp() }).catch(() => {}); };
      this.listen(D.onValue(this.r('st'), (s) => netApplyState(s.val())));
      // 出来事は、つないだ後に増えたものだけ再生する
      D.get(D.query(this.r('ev'), D.orderByKey(), D.limitToLast(1))).then((snap) => {
        let last = null;
        snap.forEach((c) => { last = c.key; });
        const q = last ? D.query(this.r('ev'), D.orderByKey(), D.startAfter(last)) : this.r('ev');
        this.listen(D.onChildAdded(q, (c) => netApplyEvent(c.val())));
      });
    }
    NET.onLeave = () => this.leave();
    netBegin({ roster, set, me, role: this.role });
  },
  onMembers() {
    if (this.begun) {
      // 対戦中に抜けた人の席はCPUにする（ホスト）
      if (this.role === 'host' && this.meta && this.meta.roster) {
        this.meta.roster.forEach((r, i) => { if (!r.cpu && r.uid && !this.members[r.uid]) netSeatToCpu(i); });
      }
      return;
    }
    renderLobby();
  },
  onMeta() {
    if (!this.meta) { // 部屋が消えた＝ホストが閉じた
      this.leave(this.role === 'guest' ? 'ホストが部屋を閉じました。' : '部屋が閉じられました。もう一度作ってください。');
      return;
    }
    if (this.role === 'guest') {
      if (this.meta.away && !this.awayTimer) this.awayTimer = setTimeout(() => this.leave('ホストとの接続が切れました。'), HOST_AWAY_MS);
      if (!this.meta.away && this.awayTimer) { clearTimeout(this.awayTimer); this.awayTimer = null; }
    }
    if (!this.begun && this.meta.status === 'play' && this.meta.roster) {
      this.beginNet(this.meta.roster, this.meta.set);
      return;
    }
    if (!this.begun) renderLobby();
  },
  /** 部屋を出る（ホストなら部屋ごと消す） */
  leave(msg) {
    const wasBegun = this.begun;
    this.detach();
    clearTimeout(this.awayTimer); this.awayTimer = null;
    if (this.ctx && this.code) {
      const { D, uid } = this.ctx;
      D.onDisconnect(this.role === 'host' ? this.r('meta/away') : this.r(`members/${uid}`)).cancel().catch(() => {});
      if (this.role === 'host') D.remove(this.r()).catch(() => {});
      else D.remove(this.r(`members/${uid}`)).catch(() => {});
    }
    this.code = null; this.role = null; this.begun = false; this.members = {}; this.meta = null; this.me = null;
    this.chat = [];
    renderChat();
    if (wasBegun && online()) { NET.onLeave = null; toMenu(); }
    else if (wasBegun) { /* toMenu から呼ばれた */ }
    showOnlineEntry();
    if (msg) {
      $('titleMsg').textContent = msg;
      $('onMsg').textContent = msg;
    }
  },
};

/* ================= 画面 ================= */
const onMsg = (t) => { $('onMsg').textContent = t || ''; };
function myMember() {
  const name = ($('onName').value || '').trim().slice(0, 8) || 'プレイヤー';
  PROFILES[0].name = name;
  saveSettings();
  const pr = PROFILES[0];
  return { name, hair: pr.hair, color: pr.color, bonus: pr.bonus || 0, cs: $('netCharSendChk').checked };
}
function showOnlineEntry() {
  $('onEntry').hidden = false;
  $('onRoom').hidden = true;
  $('onChatCard').hidden = true;
}
function openOnline(code) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('active', el.id === 'online'));
  showOnlineEntry();
  onMsg('');
  $('onName').value = PROFILES[0].name || '';
  if (code) $('onCode').value = code;
  Online.start().catch((e) => onMsg(errText(e)));
}
function renderLobby() {
  if (!Online.code) return;
  $('onEntry').hidden = true;
  $('onRoom').hidden = false;
  $('onChatCard').hidden = false;
  $('onChat').hidden = false;
  $('onRoomCode').textContent = Online.code;
  const ms = Online.memberList();
  const total = Math.min(MAX_MEMBERS, Math.max(S.total, ms.length));
  $('onCount').textContent = `${ms.length}人`;
  const away = Online.meta && Online.meta.away;
  const rows = ms.map((m, i) => `<li>${esc(m.name)}${i === 0 ? '<span class="tag-host">ホスト</span>' : ''}${m.uid === Online.ctx.uid ? '（あなた）' : ''}${i === 0 && away ? '（接続待ち…）' : ''}</li>`);
  for (let i = ms.length; i < total; i++) rows.push('<li class="tag-cpu">CPU</li>');
  $('onMembers').innerHTML = rows.join('');
  const host = Online.role === 'host';
  $('onStart').hidden = !host;
  $('onWait').hidden = host;
  $('onRule').textContent = host
    ? `全体 ${total}人（CPU ${total - ms.length}）・${S.rule === 'death' ? 'デスマッチ' : '一発勝負'}・CPU ${CPU_LABEL[S.cpu]}・制限時間 ${{ easy: 'ゆっくり', normal: 'ふつう', hard: 'はやい' }[S.diff]}。ルールはスタート画面の設定が使われます。`
    : '';
}
/** Firebase のエラーを、何をすれば直るか分かる日本語にする */
function errText(e) {
  const c = String((e && (e.code || e.message)) || '');
  if (/admin-restricted-operation|operation-not-allowed/.test(c)) return 'Firebase の「匿名」ログインが有効になっていません（Authentication → ログイン方法 → 匿名）。';
  if (/PERMISSION_DENIED|permission[_-]denied/i.test(c)) return 'Firebase のルールで断られました。Realtime Database のルールに database.rules.json の内容が公開されているか確認してください。';
  if (/network|unavailable|Failed to fetch|import|timeout/i.test(c)) return '通信できませんでした。電波の良い所でもう一度試してください。';
  if (/NOCONFIG/.test(c)) return 'オンライン対戦の設定がありません。';
  if (/^[\u3000-\u9fff]/.test((e && e.message) || '')) return e.message; // こちらで用意した日本語のメッセージ
  return `うまくいきませんでした（${c.slice(0, 60)}）。`;
}
/* ---------- チャット・定型文 ---------- */
function renderChat() {
  const html = Online.chat.length
    ? Online.chat.map((m) => `<div class="m"><b>${esc(m.name || '？')}</b>${m.stamp ? `<span class="st">${esc(m.stamp)}</span>` : esc(m.text || '')}</div>`).join('')
    : '<div class="empty">まだ発言はありません。定型文を押すと声付きで送れます。</div>';
  ['onChatLog', 'ovChatLog'].forEach((id) => { const el = $(id); el.innerHTML = html; el.scrollTop = el.scrollHeight; });
}
/** 定型文を送る：自分の端末ではすぐ声を鳴らし、対戦中なら自分の席に吹き出しを出す */
function sendStamp(label) {
  if (!Online.sendChat({ stamp: label })) return;
  const seat = Online.seatOf(Online.ctx.uid);
  if (seat >= 0) playStamp(seat, label);
  if (Online.begun && seat >= 0) showBubble(seat, label);
}
function sendText(input) {
  const text = (input.value || '').trim().slice(0, 60);
  if (!text) return;
  if (Online.sendChat({ text })) input.value = '';
}
['on', 'ov'].forEach((pre) => {
  $(`${pre}Stamps`).innerHTML = STAMPS.map(([l]) => `<button data-s="${esc(l)}">${esc(l)}</button>`).join('');
  $(`${pre}Stamps`).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => sendStamp(b.dataset.s)));
  $(`${pre}ChatSend`).addEventListener('click', () => sendText($(`${pre}ChatIn`)));
  $(`${pre}ChatIn`).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendText(e.target); } });
});
$('gameStamps').innerHTML = STAMPS.map(([l]) => `<button data-s="${esc(l)}">${esc(l)}</button>`).join('');
$('gameStamps').querySelectorAll('button').forEach((b) => b.addEventListener('pointerdown', (e) => { e.preventDefault(); sendStamp(b.dataset.s); $('stampSheet').hidden = true; }));
$('stampBtn').addEventListener('click', () => { $('stampSheet').hidden = !$('stampSheet').hidden; });
// 定型文の外をタップしたら閉じる
document.addEventListener('pointerdown', (e) => {
  if (!$('stampSheet').hidden && !e.target.closest('#stampSheet') && !e.target.closest('#stampBtn')) $('stampSheet').hidden = true;
});
renderChat();

async function withBusy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { onMsg(errText(e)); } finally { btn.disabled = false; }
}

$('onlineBtn').hidden = !Online.configured();
$('onlineBtn').addEventListener('click', () => openOnline());
$('onBack').addEventListener('click', () => {
  if (Online.code) Online.leave();
  document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('active', el.id === 'title'));
});
$('onCreate').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  initAudio(6); // ボタンを押したときに音を有効にしておく（ゲーム開始は相手の操作で始まることがあるため）
  onMsg('');
  await Online.start();
  await Online.create(myMember());
  renderLobby();
}));
$('onJoin').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  initAudio(6);
  onMsg('');
  const code = ($('onCode').value || '').replace(/\D/g, '');
  if (code.length !== 4) throw new Error('部屋番号は4ケタです。');
  await Online.start();
  await Online.join(code, myMember());
  renderLobby();
}));
$('onLeave').addEventListener('click', () => Online.leave());
$('onQr').addEventListener('click', () => showQR(`部屋 ${Online.code} に招待`, `${appUrl()}?room=${Online.code}`));
$('onStart').addEventListener('click', (e) => withBusy(e.currentTarget, () => Online.startGame()));
$('onShare').addEventListener('click', () => {
  const url = `${appUrl()}?room=${Online.code}`;
  const done = () => onMsg('招待リンクをコピーしました。LINEなどで送ってください。');
  if (navigator.share) navigator.share({ title: 'ちんちん侍', text: `部屋番号 ${Online.code} で待ってる！`, url }).catch(() => {});
  else if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => onMsg(url));
  else onMsg(url);
});
// 招待リンク（?room=1234）で開いたら、部屋番号を入れた状態でオンライン画面へ
{
  const code = new URLSearchParams(location.search).get('room');
  if (code && /^\d{4}$/.test(code) && Online.configured()) openOnline(code);
}
