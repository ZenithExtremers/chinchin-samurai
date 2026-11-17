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
const ROOM_KEY = 'chinchin-samurai-room'; // 入っている部屋（閉じても戻れるように）
const ROOM_KEEP_MS = 3 * 3600 * 1000;
function saveRoom(code) { try { localStorage.setItem(ROOM_KEY, JSON.stringify({ code, at: Date.now() })); } catch (e) { /* noop */ } }
function clearRoom() { try { localStorage.removeItem(ROOM_KEY); } catch (e) { /* noop */ } }
function savedRoom() {
  try {
    const r = JSON.parse(localStorage.getItem(ROOM_KEY) || 'null');
    return r && /^\d{4}$/.test(r.code) && Date.now() - r.at < ROOM_KEEP_MS ? r.code : null;
  } catch (e) { return null; }
}

const Online = {
  p: null, ctx: null,
  code: null, role: null, offs: [], gameOffs: [], begun: false, members: {}, meta: null, me: null, awayTimer: null,
  chat: [], joinedAt: 0, lastSent: 0,
  tally: {}, games: 0, // この部屋の戦績（部屋を出たらリセット）

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
    D.onValue(D.ref(db, '.info/serverTimeOffset'), (s) => { const off = s.val() || 0; NET.clock = () => Date.now() + off; });
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
          if (this.me) {
            // 一覧から外れていたら入り直す（対戦中でも、自分の席があれば戻れる。戻るまではCPUが代わりに遊ぶ）
            const mine = await D.get(this.r(`members/${uid}`));
            const meta = (await D.get(this.r('meta'))).val();
            const ok = meta && (meta.status === 'lobby' || (meta.seats && meta.seats[uid]));
            if (!mine.exists() && ok) await D.set(this.r(`members/${uid}`), { ...this.me, at: D.serverTimestamp() });
          }
        }
      } catch (e) { /* 次につながったときにまた試す */ }
    });
  },
  r(path) { return this.ctx.D.ref(this.ctx.db, `rooms/${this.code}${path ? '/' + path : ''}`); },
  listen(unsub) { this.offs.push(unsub); },
  listenGame(unsub) { this.gameOffs.push(unsub); }, // 対戦の間だけの見張り（待合室に戻ったら外す）
  detachGame() { this.gameOffs.forEach((f) => { try { f(); } catch (e) { /* noop */ } }); this.gameOffs = []; },
  detach() { this.detachGame(); this.offs.forEach((f) => { try { f(); } catch (e) { /* noop */ } }); this.offs = []; },

  /** 部屋を作る（4ケタの番号。空いている番号が見つかるまで試す） */
  async create(member) {
    const { D, uid } = this.ctx;
    for (let k = 0; k < 15; k++) {
      this.code = String(1000 + Math.floor(Math.random() * 9000));
      const set = { total: S.total, rule: S.rule, cpu: S.cpu, diff: S.diff, safe: $('safeChk').checked, feint: $('feintChk').checked, nocpu: false };
      const res = await D.runTransaction(this.r('meta'), (cur) => (cur === null ? { host: uid, status: 'lobby', at: Date.now(), set } : undefined));
      if (!res.committed) continue;
      this.role = 'host';
      this.me = member;
      saveRoom(this.code);
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
    if (!meta) { this.code = null; clearRoom(); throw new Error('その番号の部屋はありません。'); }
    if (meta.host === uid) return this.rejoinAsHost(member, meta);
    const back = meta.status === 'play' && meta.seats && meta.seats[uid]; // 対戦中に抜けた人が戻ってきた
    if (meta.status !== 'lobby' && !back) { this.code = null; throw new Error('その部屋はもう始まっています。'); }
    const ms = (await D.get(this.r('members'))).val() || {};
    if (!back && Object.keys(ms).length >= MAX_MEMBERS && !ms[uid]) { this.code = null; throw new Error('その部屋は満員です（6人まで）。'); }
    this.role = 'guest';
    this.me = member;
    saveRoom(code);
    await D.onDisconnect(this.r(`members/${uid}`)).remove();
    await D.set(this.r(`members/${uid}`), { ...member, at: D.serverTimestamp() });
    this.watchLobby();
    return code;
  },
  /**
   * ホストが自分の部屋に戻ってきた（ページを閉じた・読み込み直した）。
   * 対戦の進み具合はホストの端末にしかないので、対戦中だったら全員を待合室に戻す。
   */
  async rejoinAsHost(member, meta) {
    const { D, uid } = this.ctx;
    this.role = 'host';
    this.me = member;
    saveRoom(this.code);
    await D.onDisconnect(this.r('meta/away')).set(D.serverTimestamp());
    await D.update(this.r('meta'), { away: null, ...(meta.status === 'play' ? { status: 'lobby', roster: null, seats: null } : {}) });
    D.remove(this.r('st')).catch(() => {});
    D.remove(this.r('ev')).catch(() => {});
    D.remove(this.r('acts')).catch(() => {});
    await D.set(this.r(`members/${uid}`), { ...member, at: D.serverTimestamp() });
    this.watchLobby();
    return this.code;
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
    if (fresh && !mine && $('chatPanel').hidden) { unread++; updateChatFab(); }
    if (this.begun && seat >= 0 && !mine) showBubble(seat, m.stamp || (m.text.length > 14 ? m.text.slice(0, 14) + '…' : m.text));
    if (!fresh || mine) return; // 自分の分は送ったときに鳴らしている
    if (m.stamp) {
      if (outOfPlay(seat)) return; // 脱落した人の定型文は、決着まで音なし（妨害できないように）
      const sender = this.members[m.uid];
      if (seat >= 0 && $('netCharRecvChk').checked && (!sender || sender.cs !== false)) playStamp(seat, m.stamp, sender && Number.isInteger(sender.voice) ? sender.voice : undefined);
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
  /** 部屋のルール（足りない項目はスタート画面の設定） */
  roomSet() {
    const r = (this.meta && this.meta.set) || {};
    return { total: r.total || S.total, rule: r.rule || S.rule, cpu: r.cpu || S.cpu, diff: r.diff || S.diff, safe: !!r.safe, feint: !!r.feint, nocpu: !!r.nocpu };
  },
  /** ホスト：待合室でルールを変える */
  setRule(patch) {
    if (this.role !== 'host' || !this.code) return;
    const { D } = this.ctx;
    D.update(this.r('meta/set'), patch).catch((e) => onMsg(errText(e)));
  },
  /** 何人の席で遊ぶか（CPUなしなら参加者の数だけ） */
  seatCount(n) {
    const set = this.roomSet();
    return set.nocpu ? n : Math.min(MAX_MEMBERS, Math.max(set.total, n));
  },
  /** ホスト：席を決めて始める */
  async startGame() {
    const { D } = this.ctx;
    const ms = this.memberList();
    const rs = this.roomSet();
    if (rs.nocpu && ms.length < 2) throw new Error('CPUなしで遊ぶには、2人以上必要です。');
    const total = this.seatCount(ms.length);
    const roster = Array.from({ length: total }, (_, i) => {
      const m = ms[i];
      if (m) return { ...cleanLook(m, defaultProfile(i)), uid: m.uid, name: m.name, title: typeof m.title === 'string' ? m.title.slice(0, 12) : '', cpu: 0, bonus: m.bonus || 0, cs: m.cs !== false };
      const pr = PROFILES[i];
      return { ...cleanLook(pr, defaultProfile(i)), uid: '', name: pr.name.trim() || CPU_NAMES[(i - 1 + CPU_NAMES.length) % CPU_NAMES.length], cpu: 1, bonus: 0, cs: true };
    });
    const set = { code: this.code, rule: rs.rule, cpu: rs.cpu, diff: rs.diff, safe: rs.safe, feint: rs.feint };
    await D.remove(this.r('ev'));
    await D.remove(this.r('acts'));
    const seats = Object.fromEntries(roster.filter((r) => r.uid).map((r) => [r.uid, true])); // 途中で切れても戻れる人
    await D.update(this.r('meta'), { status: 'play', roster, seats, set: { ...this.roomSet(), ...set } });
  },
  /** ホスト：対戦のあと、全員まとめて待合室に戻す */
  async backToLobby() {
    if (this.role !== 'host') return;
    const { D } = this.ctx;
    await D.update(this.r('meta'), { status: 'lobby', roster: null, seats: null });
    D.remove(this.r('st')).catch(() => {});
    D.remove(this.r('ev')).catch(() => {});
    D.remove(this.r('acts')).catch(() => {});
  },
  /** 席の持ち主（人ならuid、CPUなら席番号） */
  keyOf(seat) {
    const r = this.meta && this.meta.roster && this.meta.roster[seat];
    return r && r.uid ? r.uid : `cpu${seat}`;
  },
  /** 戦績：切腹が出るたびに数える（final＝勝負がついた） */
  countGame(p, final) {
    (this.meta && this.meta.roster || []).forEach((r, i) => {
      const k = this.keyOf(i);
      if (!this.tally[k]) this.tally[k] = { name: r.name, cpu: !!r.cpu, sep: 0 };
      this.tally[k].name = r.name;
    });
    const t = this.tally[this.keyOf(p)];
    if (t) t.sep++;
    if (final) this.games++;
  },
  /** 待合室に戻ったとき（全員） */
  toLobby() {
    this.detachGame();
    this.begun = false;
    NET.onLeave = null;
    netToLobby();
    renderLobby();
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
      this.listenGame(D.onChildAdded(this.r('acts'), (s) => {
        const a = s.val();
        D.remove(s.ref).catch(() => {});
        const seat = seatOf(a && a.uid);
        if (seat >= 0) netHostAct(seat, a);
      }));
    } else {
      NET.send = (a) => { D.push(this.r('acts'), { ...a, uid, t: D.serverTimestamp() }).catch(() => {}); };
      this.listenGame(D.onValue(this.r('st'), (s) => netApplyState(s.val())));
      // 出来事は、つないだ後に増えたものだけ再生する
      D.get(D.query(this.r('ev'), D.orderByKey(), D.limitToLast(1))).then((snap) => {
        let last = null;
        snap.forEach((c) => { last = c.key; });
        const q = last ? D.query(this.r('ev'), D.orderByKey(), D.startAfter(last)) : this.r('ev');
        this.listenGame(D.onChildAdded(q, (c) => netApplyEvent(c.val())));
      });
    }
    NET.onLeave = () => this.leave();
    netBegin({ roster, set, me, role: this.role });
  },
  onMembers() {
    if (this.begun) {
      // 対戦中に抜けた人の席はCPUが代わり、戻ってきたら本人に返す（ホスト）
      if (this.role === 'host' && this.meta && this.meta.roster) {
        this.meta.roster.forEach((r, i) => {
          if (r.cpu || !r.uid) return;
          if (!this.members[r.uid]) netSeatToCpu(i);
          else netSeatToHuman(i);
        });
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
    if (this.begun && this.meta.status === 'lobby') { this.toLobby(); return; }
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
    this.tally = {}; this.games = 0;
    clearRoom();
    showRejoin();
    this.chat = [];
    unread = 0;
    renderChat();
    updateChatFab();
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
  return { ...cleanLook(pr, defaultProfile(0)), name, title: myTitle(), bonus: pr.bonus || 0, cs: $('netCharSendChk').checked };
}
function showOnlineEntry() {
  $('onEntry').hidden = false;
  $('onRoom').hidden = true;
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
  $('onRoomCode').textContent = Online.code;
  const ms = Online.memberList();
  const rs = Online.roomSet();
  const total = Online.seatCount(ms.length);
  $('onCount').textContent = `${ms.length}人`;
  const away = Online.meta && Online.meta.away;
  const rows = ms.map((m, i) => `<li>${esc(m.name)}${titleChip(typeof m.title === 'string' ? m.title.slice(0, 12) : '')}${i === 0 ? '<span class="tag-host">ホスト</span>' : ''}${m.uid === Online.ctx.uid ? '（あなた）' : ''}${i === 0 && away ? '（接続待ち…）' : ''}</li>`);
  for (let i = ms.length; i < total; i++) rows.push('<li class="tag-cpu">CPU</li>');
  $('onMembers').innerHTML = rows.join('');
  const host = Online.role === 'host';
  $('onStart').hidden = !host;
  $('onWait').hidden = host;
  const diffName = { easy: 'ゆっくり', normal: 'ふつう', hard: 'はやい' }[rs.diff];
  $('onRule').textContent = `${rs.nocpu ? `CPUなし・${ms.length}人` : `全体 ${total}人（CPU ${total - ms.length}）`}・${rs.rule === 'death' ? 'デスマッチ' : '一発勝負'}`
    + (rs.nocpu ? '' : `・CPU ${CPU_LABEL[rs.cpu]}${rs.safe ? '（不敗）' : ''}${rs.feint ? '・フェイントあり' : ''}`) + `・制限時間 ${diffName}`;
  $('onRuleOpen').hidden = !host; // ルールを変えられるのはホストだけ
  if (!host && !$('roomRuleSheet').hidden) closeSheets();
  renderRoomRules(host, rs, ms.length);
  updateChatFab();
}
/** ホスト：待合室でルールを変える欄 */
function renderRoomRules(host, rs, n) {
  const box = $('onRules');
  if (!host) return;
  const seg = (key, opts, cur, dis) => `<div class="seg mini" data-k="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}" ${dis && dis(v) ? 'disabled' : ''}>${l}</button>`).join('')}</div>`;
  const chk = (key, label, cur) => `<label class="row"><span>${label}</span><input type="checkbox" data-k="${key}" ${cur ? 'checked' : ''}></label>`;
  box.innerHTML = `
    ${chk('nocpu', 'CPUなし（参加者だけで遊ぶ）', rs.nocpu)}
    ${rs.nocpu ? '' : `<h4>全体の人数</h4>${seg('total', [[3, '3人'], [4, '4人'], [5, '5人'], [6, '6人']], Math.max(rs.total, n), (v) => v < n)}`}
    <h4>対戦形式</h4>${seg('rule', [['normal', '一発勝負'], ['death', 'デスマッチ']], rs.rule)}
    ${rs.nocpu ? '' : `<h4>CPUの強さ</h4>${seg('cpu', [['weak', '弱い'], ['normal', '普通'], ['strong', '強い']], rs.cpu)}
    ${chk('safe', 'CPUは絶対に負けない', rs.safe)}${chk('feint', 'CPUのフェイント', rs.feint)}`}
    <h4>制限時間</h4>${seg('diff', [['easy', 'ゆっくり'], ['normal', 'ふつう'], ['hard', 'はやい']], rs.diff)}`;
  box.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    const k = b.closest('.seg').dataset.k;
    Online.setRule({ [k]: k === 'total' ? +b.dataset.v : b.dataset.v });
  }));
  box.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', () => Online.setRule({ [c.dataset.k]: c.checked })));
}
/** 待合室：自分の設定（スタート画面の設定とつながっている） */
function renderMine() {
  const toggles = [['swipeChk', 'スワイプモード'], ['guideChk', '案内を出す（初心者向け）'], ['movieChk', '切腹ムービー'], ['ttsChk', 'セリフの音声を出す']];
  $('onMine').innerHTML = `<h4>入力</h4><div class="seg mini" id="onMineMode">
      <button data-v="button" class="${S.mode === 'button' ? 'on' : ''}">セリフボタン</button>
      <button data-v="voice" class="${S.mode === 'voice' ? 'on' : ''}">音声入力</button></div>`
    + toggles.map(([id, label]) => `<label class="row"><span>${label}</span><input type="checkbox" data-id="${id}" ${$(id).checked ? 'checked' : ''}></label>`).join('');
  $('onMineMode').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    $('modeSeg').querySelector(`button[data-v="${b.dataset.v}"]`).click(); // スタート画面のモードを切り替える（保存もされる）
    renderMine();
  }));
  $('onMine').querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', () => {
    $(c.dataset.id).checked = c.checked;
    saveSettings();
  }));
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
let unread = 0;
/** デスマッチで脱落していて、まだ決着がついていない人か */
function outOfPlay(seat) {
  return Online.begun && death() && seat >= 0 && !S.alive.has(seat) && S.alive.size > 1;
}
/** 脱落した人は、対戦の言葉（ちんちん侍・シャキーン・びろーん・切腹）の定型文を送れない */
const GAME_STAMPS = ['ちんちん侍！', 'シャキーン', 'びろーん', '切腹！'];
function stampBlocked(label) { return GAME_STAMPS.includes(label) && outOfPlay(Online.seatOf(Online.ctx.uid)); }
function renderStampLocks() {
  document.querySelectorAll('#chatStamps button, #gameStamps button').forEach((b) => { b.disabled = Online.code ? stampBlocked(b.dataset.s) : false; });
}
function renderChat() {
  const html = Online.chat.length
    ? Online.chat.map((m) => `<div class="m"><b>${esc(m.name || '？')}</b>${m.stamp ? `<span class="st">${esc(m.stamp)}</span>` : esc(m.text || '')}</div>`).join('')
    : '<div class="empty">まだ発言はありません。定型文を押すと声付きで送れます。</div>';
  const el = $('chatLog');
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}
/** 右下のチャットボタン：部屋にいて、待合室か結果画面のときだけ出す（対戦中は「定型文」ボタン） */
function updateChatFab() {
  const lobby = $('online').classList.contains('active');
  const result = $('game').classList.contains('active') && $('overlay').classList.contains('show');
  const show = !!Online.code && (lobby || result);
  $('chatFab').hidden = !show || !$('chatPanel').hidden;
  if (!show) $('chatPanel').hidden = true;
  $('chatBadge').hidden = unread === 0;
  $('chatBadge').textContent = unread > 99 ? '99+' : String(unread);
}
function openChat(open) {
  $('chatPanel').hidden = !open;
  if (open) { unread = 0; renderStampLocks(); const el = $('chatLog'); el.scrollTop = el.scrollHeight; }
  updateChatFab();
}
// 画面や結果画面が切り替わったら、ボタンを出す・隠す
{
  const mo = new MutationObserver(() => updateChatFab());
  ['online', 'game', 'overlay'].forEach((id) => mo.observe($(id), { attributes: true, attributeFilter: ['class'] }));
}
$('chatFab').addEventListener('click', () => openChat(true));
$('chatClose').addEventListener('click', () => openChat(false));
// パネルの外をタップしたら閉じる
document.addEventListener('pointerdown', (e) => {
  if (!$('chatPanel').hidden && !e.target.closest('#chatPanel') && !e.target.closest('#chatFab')) openChat(false);
});
/** 定型文を送る：自分の端末ではすぐ声を鳴らし、対戦中なら自分の席に吹き出しを出す */
function sendStamp(label) {
  if (stampBlocked(label)) return;
  if (!Online.sendChat({ stamp: label })) return;
  const seat = Online.seatOf(Online.ctx.uid);
  if (seat >= 0 && !outOfPlay(seat)) playStamp(seat, label, PROFILES[0].voice);
  if (Online.begun && seat >= 0) showBubble(seat, label);
}
function sendText(input) {
  const text = (input.value || '').trim().slice(0, 60);
  if (!text) return;
  if (Online.sendChat({ text })) input.value = '';
}
$('chatStamps').innerHTML = STAMPS.map(([l]) => `<button data-s="${esc(l)}">${esc(l)}</button>`).join('');
$('chatStamps').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => sendStamp(b.dataset.s)));
$('chatSend').addEventListener('click', () => sendText($('chatIn')));
$('chatIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendText(e.target); } });
// 対戦中の定型文：送ったあとも開いたまま（外をタップか「定型文」ボタンで閉じる）
$('gameStamps').innerHTML = STAMPS.map(([l]) => `<button data-s="${esc(l)}">${esc(l)}</button>`).join('');
$('gameStamps').querySelectorAll('button').forEach((b) => b.addEventListener('pointerdown', (e) => { e.preventDefault(); sendStamp(b.dataset.s); }));
$('stampBtn').addEventListener('click', () => { $('stampSheet').hidden = !$('stampSheet').hidden; if (!$('stampSheet').hidden) renderStampLocks(); });
document.addEventListener('pointerdown', (e) => {
  if (!$('stampSheet').hidden && !e.target.closest('#stampSheet') && !e.target.closest('#stampBtn')) $('stampSheet').hidden = true;
});
renderChat();
renderMine();

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
// 待合室のタブ（参加者／自分の設定）
document.querySelectorAll('.ltabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.ltabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('onPanelMembers').hidden = b.dataset.t !== 'members';
  $('onPanelMine').hidden = b.dataset.t !== 'mine';
  if (b.dataset.t === 'mine') renderMine();
}));
$('onRuleOpen').addEventListener('click', () => openSheet('roomRuleSheet'));
$('roomRuleDone').addEventListener('click', closeSheets);
$('lobbyBtn').addEventListener('click', () => Online.backToLobby().catch((e) => onMsg(errText(e))));
$('onShare').addEventListener('click', () => {
  const url = `${appUrl()}?room=${Online.code}`;
  const done = () => onMsg('招待リンクをコピーしました。LINEなどで送ってください。');
  if (navigator.share) navigator.share({ title: 'ちんちん侍', text: `部屋番号 ${Online.code} で待ってる！`, url }).catch(() => {});
  else if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => onMsg(url));
  else onMsg(url);
});
/** タイトル：閉じてしまった部屋に戻るボタン */
function showRejoin() {
  const code = Online.configured() && !Online.code ? savedRoom() : null;
  $('rejoinBtn').hidden = !code;
  if (code) $('rejoinBtn').textContent = `部屋 ${code} に戻る`;
}
$('rejoinBtn').addEventListener('click', () => {
  const code = savedRoom();
  if (!code) { showRejoin(); return; }
  openOnline(code);
  $('onJoin').click();
});
showRejoin();
// 招待リンク（?room=1234）で開いたら、部屋番号を入れた状態でオンライン画面へ
{
  const code = new URLSearchParams(location.search).get('room');
  if (code && /^\d{4}$/.test(code) && Online.configured()) openOnline(code);
}
