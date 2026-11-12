// WeddingSCAN 도우미 링크 시험판 (GitHub Pages)
// 이 휴대폰 브라우저에만 저장합니다: 시험 설정, 장부, Claude API 키.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return '날짜 미정';
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return (+m[1] !== new Date().getFullYear() ? m[1] + '년 ' : '') + (+m[2]) + '월 ' + (+m[3]) + '일 (' + '일월화수목금토'[d.getDay()] + ')';
  }
  function won(man) { return (man * 10000).toLocaleString('ko-KR') + '원'; }
  function manwonLabel(man) { return man.toLocaleString('ko-KR') + '만 원'; }
  function toInt(v) { if (v === null || v === undefined || v === '') return null; var n = parseInt(String(v).replace(/[^0-9]/g, ''), 10); return isNaN(n) ? null : n; }

  // 저장: localStorage가 막혀 있어도 이 창 안에서는 동작하게 메모리에도 둡니다
  var MEM = {};
  function load(k, def) { try { var v = localStorage.getItem(k); if (v !== null) return JSON.parse(v); } catch (e) {} return k in MEM ? MEM[k] : def; }
  function save(k, v) { MEM[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function drop(k) { delete MEM[k]; try { localStorage.removeItem(k); } catch (e) {} }

  var DEFAULT_CFG = { ledgerName: '신랑 측 장부 (시험)', date: todayStr(), venue: '', pin: '1234', alwaysOpen: true };
  var S = { view: 'home', q: '', busy: false, photos: [], status: null, err: '', cash: '', prev: 'home', wipeArmed: false, rows: load('ws-rows', []), name: load('ws-name', '') };
  var COMMON = [1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 100];
  var BLUR_MIN = 40; // 선명도 점수가 이보다 낮으면 "흔들렸어요" (시험하며 조정)
  var MODEL_FIRST = 'claude-sonnet-5-5', MODEL_REVIEW = 'claude-opus-5-5';

  function cfg() { var c = {}, src = load('ws-cfg', {}) || {}; for (var k in DEFAULT_CFG) c[k] = (src[k] !== undefined && src[k] !== '') ? src[k] : DEFAULT_CFG[k]; return c; }
  function gateState() { var c = cfg(); if (c.alwaysOpen) return 'open'; var t = todayStr(); return t < c.date ? 'before' : t > c.date ? 'after' : 'open'; }
  function unlockKey() { var c = cfg(); return c.date + ':' + c.pin; }
  function unlocked() { return load('ws-unlock', '') === unlockKey(); }
  function apiKey() { return load('ws-key', ''); }
  function saveRows() { save('ws-rows', S.rows); }

  /* ---------- 장부 계산 ---------- */
  function dupMap() { var d = {}; S.rows.forEach(function (r) { if (r.no !== null) d[r.no] = (d[r.no] || 0) + 1; }); return d; }
  function reason(r, dup) {
    if (r.no === null) return '번호를 못 읽었어요';
    if (r.amount === null) return '금액을 못 읽었어요';
    if (!r.name) return '이름을 못 읽었어요';
    if (dup[r.no] > 1) return '번호가 겹쳐요';
    if (r.disagree) return '두 번 읽은 값이 달라요';
    if (COMMON.indexOf(r.amount) < 0) return '금액을 확인해 주세요';
    if (r.conf < 0.8) return '글씨가 흐려요';
    return '';
  }
  function sorted() { return S.rows.slice().sort(function (a, b) { return (a.no === null ? 1e9 : a.no) - (b.no === null ? 1e9 : b.no); }); }
  function totals() {
    var dup = dupMap(), need = 0, sum = 0;
    S.rows.forEach(function (r) { sum += (r.amount || 0); if (reason(r, dup)) need++; });
    var nums = S.rows.map(function (r) { return r.no; }).filter(function (n) { return n !== null; });
    var max = nums.length ? Math.max.apply(null, nums) : 0, miss = [];
    if (max <= 2000) for (var i = 1; i <= max; i++) if (!dup[i]) miss.push(i);
    return { count: S.rows.length, sum: sum, need: need, miss: miss };
  }

  /* ---------- 화면 ---------- */
  function statsHTML() {
    var t = totals();
    return '<div class="sum"><div><small>정리된 봉투</small><b>' + t.count + '장</b></div><div><small>현금 합계</small><b>' + manwonLabel(t.sum) + '</b></div>' +
      '<div class="need"><small>확인 필요</small><b>' + t.need + '장</b></div></div>';
  }
  function rowHTML(r, dup) {
    var why = reason(r, dup);
    return '<li class="lrow"><span class="no">' + (r.no === null ? '?' : r.no) + '</span><span class="nm">' + esc(r.name || '(이름 없음)') +
      '<small>' + (r.memo ? esc(r.memo) + ' · ' : '') + (r.by ? esc(r.by) + ' 찍음' : '') + (r.candidates && r.candidates.length > 1 ? ' · 후보: ' + esc(r.candidates.join(', ')) : '') + '</small>' +
      (why ? '<small class="flag">' + why + '</small>' : '') + '</span><span class="am">' + (r.amount === null ? '?' : won(r.amount)) + '</span></li>';
  }
  var V = {};
  V.gate = function () {
    var c = cfg(), after = gateState() === 'after';
    return '<section class="card center"><div class="mark">' + (after ? '🔒' : '📅') + '</div>' +
      '<h1>' + (after ? '예식이 끝나<br>촬영 링크가 닫혔어요' : '이 페이지는<br>예식 당일에만 열려요') + '</h1>' +
      '<p class="lead">' + (after ? '이 링크는 ' + fmtDate(c.date) + ' 하루만 열렸어요. 장부와 엑셀은 혼주님이 확인할 수 있어요.'
        : esc(c.ledgerName) + ' 촬영 링크예요. ' + fmtDate(c.date) + ' 0시에 열리고, 그날 밤 12시에 닫혀요.') + '</p>' +
      '<dl class="kv"><div><dt>장부</dt><dd>' + esc(c.ledgerName) + '</dd></div><div><dt>예식</dt><dd>' + fmtDate(c.date) + '</dd></div>' +
      (c.venue ? '<div><dt>예식장</dt><dd>' + esc(c.venue) + '</dd></div>' : '') + '<div><dt>열리는 시간</dt><dd>예식 당일 0시~24시</dd></div></dl></section>';
  };
  V.entry = function () {
    var c = cfg();
    return '<section><p class="eyebrow">도우미 촬영 링크</p><h1>' + esc(c.ledgerName) + ' 정리를<br>도와주셔서 고마워요</h1>' +
      '<dl class="kv" style="margin-top:16px"><div><dt>예식</dt><dd>' + fmtDate(c.date) + '</dd></div>' + (c.venue ? '<div><dt>예식장</dt><dd>' + esc(c.venue) + '</dd></div>' : '') +
      '<div><dt>링크가 닫히는 시간</dt><dd>' + (c.alwaysOpen ? '시험 중에는 열려 있어요' : '오늘 밤 12시') + '</dd></div></dl>' +
      '<form id="entryForm" class="fields" novalidate>' +
      '<label class="field" for="pin">비밀번호 4자리<input id="pin" class="pin" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="혼주님께 받은 숫자 4자리"><span class="hint">시험판 비밀번호: ' + esc(c.pin) + ' (설정에서 바꿀 수 있어요)</span></label>' +
      '<label class="field" for="hname">찍는 분 이름 (선택)<input id="hname" autocomplete="off" placeholder="예: 큰고모" value="' + esc(S.name) + '"><span class="hint">여러 명이 함께 찍을 때 누가 찍었는지 장부에 남아요</span></label>' +
      (S.err ? '<p class="err" role="alert">' + esc(S.err) + '</p>' : '') +
      '<button class="btn" type="submit">시작하기</button></form>' +
      '<p class="note">설치와 가입은 필요 없어요. 이 휴대폰에서는 오늘 하루 비밀번호를 다시 묻지 않아요.</p></section>';
  };
  V.home = function () {
    var c = cfg(), dup = dupMap();
    var recent = S.rows.slice().sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); }).slice(0, 5);
    var waiting = S.photos.filter(function (p) { return p.state === 'wait' || p.state === 'fail'; }).length;
    return '<section><h1>' + (S.name ? esc(S.name) + '님, ' : '') + '봉투를 찍어 주세요</h1><p class="lead">' + esc(c.ledgerName) + (c.venue ? ' · ' + esc(c.venue) : '') + '</p></section>' +
      '<section>' + statsHTML() +
      '<div class="row"><button class="btn big" data-act="livecam">화면에서 바로 찍기</button><button class="btn ghost" data-act="cam">카메라 앱으로 찍기</button></div>' +
      '<button class="btn ghost sm" style="margin-top:8px" data-act="album">앨범에서 고르기</button>' +
      '<div class="thumbs">' + S.photos.map(function (p, i) {
        var lab = p.state === 'done' ? p.found + '장 읽음' : p.state === 'fail' ? '다시 읽기' : p.state === 'run' ? '읽는 중' : '대기';
        return '<div class="th ' + (p.state === 'done' ? 'done' : p.state === 'fail' ? 'fail' : '') + '"><img src="' + p.url + '" alt="찍은 사진 ' + (i + 1) + '"><i>' + lab + '</i>' + (p.blurry ? '<em class="blur">흐림</em>' : '') + '</div>';
      }).join('') + '</div>' +
      (waiting ? '<button class="btn" style="margin-top:12px" data-act="read"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? '읽는 중…' : '사진 ' + waiting + '장 읽어서 장부에 넣기') + '</button>' : '') +
      (S.status ? '<div class="status ' + (S.status.kind || '') + '" role="status">' + esc(S.status.text) + '</div>' : '') +
      '<div class="rule"><div class="env" aria-hidden="true"><b class="n">12</b><span>홍길동</span><b class="a">10</b></div><ul><li>현금을 꺼낸 뒤 바로 적기</li><li>위쪽 숫자는 번호, 아래쪽은 금액 (10 = 10만 원)</li><li>여러 장을 펼쳐 한 번에 찍어도 돼요</li></ul></div></section>' +
      '<section><div class="menu"><button data-act="go" data-val="ledger"><span>장부 보기 (이름 찾기)</span><i>›</i></button><button data-act="go" data-val="cash"><span>현금 합계 맞춰보기</span><i>›</i></button></div></section>' +
      (recent.length ? '<section><h2>방금 정리된 봉투</h2><ul class="ledger">' + recent.map(function (r) { return rowHTML(r, dup); }).join('') + '</ul></section>' : '') +
      '<p class="note">결제, 엑셀 받기, 장부 고치기는 혼주님만 할 수 있어요. 시험판에서는 설정에서 엑셀을 받을 수 있어요.</p>';
  };
  V.ledger = function () {
    var t = totals(), dup = dupMap(), q = S.q.trim();
    var list = sorted().filter(function (r) { return !q || (r.name || '').indexOf(q) >= 0 || String(r.no) === q; });
    return '<section><button class="back" data-act="go" data-val="home">‹ 도우미 홈</button><h1>장부 보기</h1></section><section>' + statsHTML() +
      (t.miss.length ? '<div class="status warn">빠진 번호 ' + t.miss.length + '개: ' + t.miss.slice(0, 30).join(', ') + (t.miss.length > 30 ? ' …' : '') + '</div>' : '') +
      '<label class="field" for="q" style="margin-top:14px">이름이나 번호로 찾기<input id="q" type="search" autocomplete="off" placeholder="예: 김민준" value="' + esc(S.q) + '"></label>' +
      '<ul class="ledger" style="margin-top:10px">' + (list.length ? list.map(function (r) { return rowHTML(r, dup); }).join('') : '<li class="empty">' + (S.rows.length ? '맞는 이름이 없어요.' : '아직 정리된 봉투가 없어요. 도우미 홈에서 찍어 주세요.') + '</li>') + '</ul>' +
      '<p class="note">고치기와 엑셀 받기는 혼주님만 할 수 있어요.</p></section>';
  };
  V.cash = function () {
    var t = totals(), cash = toInt(S.cash), out = '';
    if (cash !== null) {
      var diff = cash - t.sum;
      out = diff === 0 ? '<div class="status ok">장부 합계와 현금이 ' + manwonLabel(t.sum) + '으로 정확히 맞아요.</div>'
        : '<div class="status warn">현금이 장부보다 ' + manwonLabel(Math.abs(diff)) + (diff > 0 ? ' 많아요.' : ' 적어요.') + ' 혼주님이 사진을 보며 확인할 수 있게 알려 주세요.' + (t.miss.length ? ' 빠진 번호: ' + t.miss.slice(0, 10).join(', ') : '') + '</div>';
    }
    return '<section><button class="back" data-act="go" data-val="home">‹ 도우미 홈</button><h1>현금 합계 맞춰보기</h1><p class="lead">예식장 비용을 내기 전에 실제로 센 현금과 장부 합계를 맞춰 봐요.</p></section>' +
      '<section>' + statsHTML() + '<form id="cashForm" class="fields"><label class="field" for="cashIn">실제로 센 현금 (만 원)<input id="cashIn" inputmode="numeric" autocomplete="off" placeholder="예: 2850" value="' + esc(S.cash) + '"></label>' +
      '<button class="btn" type="submit">맞춰보기</button></form>' + out + '</section>';
  };
  V.key = function () {
    return '<section><button class="back" data-act="go" data-val="home">‹ 도우미 홈</button><h1>Claude API 키를<br>넣어 주세요</h1>' +
      '<p class="lead">시험판은 이 휴대폰에서 바로 Claude를 불러 봉투를 읽어요. 키는 이 휴대폰 브라우저에만 저장되고, 어디에도 보내지 않아요 (Claude API 호출 제외).</p></section>' +
      '<form id="keyForm" class="fields"><label class="field" for="keyIn">API 키<input id="keyIn" class="mono" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-ant-로 시작하는 키"></label>' +
      (S.err ? '<p class="err" role="alert">' + esc(S.err) + '</p>' : '') +
      '<button class="btn" type="submit">저장하고 읽기</button></form>' +
      '<div class="keybox">키는 console.anthropic.com 의 API Keys에서 만들 수 있어요. 시험용 키를 따로 만들고, 시험이 끝나면 설정에서 지우거나 콘솔에서 키를 없애 주세요. 이 링크와 키를 다른 사람에게 보내지 마세요.</div>';
  };
  V.settings = function () {
    var c = cfg(), k = apiKey();
    return '<section><button class="back" data-act="go" data-val="' + esc(S.prev) + '">‹ 돌아가기</button><h1>시험 설정</h1><p class="lead">이 휴대폰에만 저장돼요. 실제 서비스에서는 혼주님만 바꿀 수 있어요.</p></section>' +
      '<form id="cfgForm" class="fields">' +
      '<label class="field" for="cLedger">장부 이름<input id="cLedger" value="' + esc(c.ledgerName) + '"></label>' +
      '<label class="field" for="cDate">예식 날짜<input id="cDate" type="date" value="' + esc(c.date) + '"></label>' +
      '<label class="field" for="cVenue">예식장<input id="cVenue" value="' + esc(c.venue) + '" placeholder="예: 웨딩스캔 컨벤션 그랜드홀 3층"></label>' +
      '<label class="field" for="cPin">도우미 비밀번호 4자리<input id="cPin" class="pin" inputmode="numeric" maxlength="4" value="' + esc(c.pin) + '"></label>' +
      '<label class="check" for="cOpen"><input id="cOpen" type="checkbox"' + (c.alwaysOpen ? ' checked' : '') + '><span><b>시험 중에는 날짜와 상관없이 열기</b>끄면 예식 날짜에만 열리고, 다른 날에는 안내 페이지가 보여요.</span></label>' +
      (S.err ? '<p class="err" role="alert">' + esc(S.err) + '</p>' : '') +
      '<button class="btn" type="submit">저장하기</button></form>' +
      '<section><h2>시험 도구</h2><div class="tools">' +
      '<div class="keybox">Claude API 키: ' + (k ? '<span class="mono">' + esc(k.slice(0, 10)) + '…' + esc(k.slice(-4)) + '</span> 저장됨' : '없음') + '</div>' +
      (k ? '<button class="btn ghost danger" data-act="delkey">키 지우기</button>' : '<button class="btn ghost" data-act="go" data-val="key">키 넣기</button>') +
      '<button class="btn ghost" data-act="excel"' + (S.rows.length ? '' : ' disabled') + '>엑셀로 받기 (봉투 ' + S.rows.length + '장)</button>' +
      '<button class="btn ghost danger" data-act="wipe"' + (S.rows.length ? '' : ' disabled') + '>' + (S.wipeArmed ? '한 번 더 누르면 모두 지워요' : '장부 비우기') + '</button>' +
      '<button class="btn ghost" data-act="relock">비밀번호 화면 다시 보기</button></div></section>';
  };

  function currentView() {
    if (S.view === 'settings' || S.view === 'key') return S.view;
    if (gateState() !== 'open') return 'gate';
    if (!unlocked()) return 'entry';
    return ['home', 'ledger', 'cash'].indexOf(S.view) >= 0 ? S.view : 'home';
  }
  function render() { $('view').innerHTML = V[currentView()](); }
  function go(v) { S.view = v; S.err = ''; S.wipeArmed = false; render(); window.scrollTo(0, 0); }

  /* ---------- 사진: 줄이기와 흐림 점수 ---------- */
  function sharpness(canvas) {
    // 긴 쪽 320px 흑백에서 라플라시안 분산 (값이 낮을수록 흐림)
    var k = Math.min(1, 320 / Math.max(canvas.width, canvas.height));
    var w = Math.max(3, Math.round(canvas.width * k)), h = Math.max(3, Math.round(canvas.height * k));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var g = c.getContext('2d'); g.drawImage(canvas, 0, 0, w, h);
    var d = g.getImageData(0, 0, w, h).data, gray = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    var sum = 0, sq = 0, n = 0;
    for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) {
      var j = y * w + x, l = gray[j - w] + gray[j + w] + gray[j - 1] + gray[j + 1] - 4 * gray[j];
      sum += l; sq += l * l; n++;
    }
    var mean = sum / n; return Math.round(sq / n - mean * mean);
  }
  function fromCanvas(src) {
    var k = Math.min(1, 1568 / Math.max(src.width, src.height)), c = document.createElement('canvas');
    c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    var score = sharpness(c);
    return new Promise(function (res, rej) {
      c.toBlob(function (b) { b ? res({ blob: b, url: URL.createObjectURL(b), state: 'wait', found: 0, score: score, blurry: score < BLUR_MIN }) : rej(new Error('blob')); }, 'image/jpeg', 0.85);
    });
  }
  function fromFile(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), im = new Image();
      im.onload = function () {
        var c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
        c.getContext('2d').drawImage(im, 0, 0); URL.revokeObjectURL(url);
        fromCanvas(c).then(res, rej);
      };
      im.onerror = function () { URL.revokeObjectURL(url); rej(new Error('load')); };
      im.src = url;
    });
  }
  function addPhotos(ps) {
    var ok = ps.filter(Boolean), blurry = ok.filter(function (p) { return p.blurry; }).length;
    S.photos = S.photos.concat(ok);
    S.status = { kind: blurry ? 'warn' : '', text: ok.length + '장을 올렸어요.' + (ps.length - ok.length ? ' ' + (ps.length - ok.length) + '장은 열 수 없는 파일이라 뺐어요.' : '') + (blurry ? ' ' + blurry + '장은 흐려 보여요. 다시 찍는 것을 권해요.' : '') + ' 더 찍거나 "읽어서 장부에 넣기"를 눌러 주세요.' };
    render();
  }
  function addFiles(list) {
    var fs = Array.prototype.slice.call(list || []); if (!fs.length) return;
    S.status = { text: '사진을 줄이는 중…' }; render();
    Promise.all(fs.map(function (f) { return fromFile(f).catch(function () { return null; }); })).then(addPhotos);
  }
  $('camIn').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
  $('albumIn').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });

  /* ---------- 화면 안 카메라 ---------- */
  var stream = null, shots = [];
  function openLiveCam() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { S.status = { kind: 'warn', text: '이 브라우저는 화면 안 카메라를 지원하지 않아요. "카메라 앱으로 찍기"를 써 주세요.' }; render(); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false }).then(function (s) {
      stream = s; shots = [];
      $('camLayer').hidden = false; $('camVideo').srcObject = s; $('camVideo').play().catch(function () {});
      $('camCount').textContent = '0장'; $('camThumb').innerHTML = ''; camMsg('봉투를 화면에 가득 채워 찍어 주세요. 여러 장을 펼쳐 찍어도 돼요.');
    }, function (err) {
      var msg = err && err.name === 'NotAllowedError' ? '카메라 사용을 허용하지 않았어요. 브라우저 주소창의 권한 설정에서 카메라를 허용해 주세요.' : '카메라를 열지 못했어요. "카메라 앱으로 찍기"를 써 주세요.';
      S.status = { kind: 'warn', text: msg }; render();
    });
  }
  function camMsg(t, warn) { var m = $('camMsg'); m.textContent = t; m.className = 'cam-msg' + (warn ? ' warn' : ''); }
  function shoot() {
    var v = $('camVideo'); if (!v.videoWidth) return;
    var c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    fromCanvas(c).then(function (p) {
      shots.push(p); $('camCount').textContent = shots.length + '장';
      $('camThumb').innerHTML = '<img src="' + p.url + '" alt="">';
      if (p.blurry) camMsg('흔들렸어요. 한 번만 다시 찍어 주세요. (선명도 ' + p.score + ')', true);
      else camMsg('찍었어요. 계속 찍거나 "다 찍었어요"를 눌러 주세요. (선명도 ' + p.score + ')');
    });
  }
  function closeLiveCam() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; $('camVideo').srcObject = null; $('camLayer').hidden = true;
    if (shots.length) addPhotos(shots); shots = [];
  }
  $('camShutter').addEventListener('click', shoot);
  $('camDone').addEventListener('click', closeLiveCam);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('camLayer').hidden) closeLiveCam(); });

  /* ---------- Claude API로 읽기 ---------- */
  var RULES = '봉투 위쪽 숫자는 번호, 아래쪽 숫자는 금액(만 원 단위, 10 = 10만 원)입니다. 이름은 보통 세로로 적혀 있고 위치는 다양합니다. 한자 이름은 한글 음으로 옮기고 원래 한자를 memo에 적으십시오. "외 2인", 회사·모임 이름은 memo에 넣으십시오. 봉투에 인쇄된 "祝結婚" 같은 문구는 무시하십시오. 읽을 수 없는 값은 지어내지 말고 null로 두십시오.';
  var FIRST = ['축의금 봉투 사진을 읽어 장부로 옮깁니다. 사진은 보낸 순서대로 1번, 2번… 입니다. 사진 한 장에 봉투가 여러 장일 수 있으니 보이는 봉투를 모두 읽으십시오.', RULES,
    'JSON 배열만 답하십시오: [{"photo":1,"no":12,"name":"홍길동","amount":10,"memo":"","conf":0.9}] conf는 정확히 읽었다는 확신(0~1). 봉투가 없으면 [].'].join('\n');
  var REVIEW = ['다른 사람이 먼저 읽었지만 확실하지 않은 봉투입니다. 먼저 읽은 값은 따라가지 말고 사진에서 직접 확인하십시오. 사진은 보낸 순서대로 1번, 2번… 입니다.', RULES,
    'JSON 배열만 답하십시오. 봉투마다 하나, ref는 그대로: [{"ref":"a1","no":12,"name":"홍길동","amount":10,"memo":"","conf":0.9,"alt_names":["홍길돈"]}] alt_names는 가능성 있는 다른 이름(최대 2개).', '다시 볼 봉투:'].join('\n');

  function b64(blob) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(',')[1]); }; r.onerror = rej; r.readAsDataURL(blob); }); }
  function apiError(code, msg) { var e = new Error(msg); e.code = code; return e; }
  async function callClaude(model, blobs, text) {
    var content = [];
    for (var i = 0; i < blobs.length; i++) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await b64(blobs[i]) } });
    content.push({ type: 'text', text: text });
    var res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey(), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: model, max_tokens: 4096, messages: [{ role: 'user', content: content }] })
      });
    } catch (e) { throw apiError('network', '인터넷 연결을 확인해 주세요.'); }
    var j = await res.json().catch(function () { return {}; });
    if (res.status === 401) throw apiError('auth', 'API 키가 맞지 않아요. 설정에서 키를 지우고 다시 넣어 주세요.');
    if (res.status === 429) throw apiError('rate', '요청이 많아 잠시 멈췄어요. 1분쯤 뒤에 다시 눌러 주세요.');
    if (res.status === 529 || res.status >= 500) throw apiError('busy', 'Claude가 지금 바빠요. 잠시 뒤 다시 눌러 주세요.');
    if (!res.ok) throw apiError('bad', '읽지 못했어요. (' + res.status + (j.error && j.error.message ? ': ' + j.error.message : '') + ')');
    var out = (j.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    var s = out.indexOf('['), e = out.lastIndexOf(']');
    if (s < 0 || e < s) throw apiError('json', '답을 표로 바꾸지 못했어요. 다시 눌러 주세요.');
    try { var arr = JSON.parse(out.slice(s, e + 1)); return Array.isArray(arr) ? arr : []; } catch (x) { throw apiError('json', '답을 표로 바꾸지 못했어요. 다시 눌러 주세요.'); }
  }
  function clean(o) { return { no: toInt(o.no), name: o.name ? String(o.name).slice(0, 40) : '', amount: toInt(o.amount), memo: o.memo ? String(o.memo).slice(0, 60) : '', conf: typeof o.conf === 'number' ? Math.max(0, Math.min(1, o.conf)) : 0.5 }; }
  async function readBatch(batch) {
    var blobs = batch.map(function (p) { return p.blob; });
    var out = await callClaude(MODEL_FIRST, blobs, FIRST + '\n\n이번에 보낸 사진은 ' + batch.length + '장입니다.');
    var rows = out.filter(function (o) { return o && typeof o === 'object'; }).map(function (o) {
      var c = clean(o); c.photo = toInt(o.photo) || 1; c.first = { no: c.no, name: c.name, amount: c.amount }; c.candidates = []; c.disagree = false; c.reviewed = false; return c;
    });
    var cnt = {}; rows.forEach(function (r) { if (r.no !== null) cnt[r.no] = (cnt[r.no] || 0) + 1; });
    var targets = []; rows.forEach(function (r, i) { if (r.no === null || r.amount === null || !r.name || r.conf < 0.8 || COMMON.indexOf(r.amount) < 0 || cnt[r.no] > 1) targets.push(i); });
    var failed = false;
    if (targets.length) {
      try {
        var items = targets.map(function (i) { var r = rows[i]; return { ref: 'a' + i, photo: r.photo, no: r.no, name: r.name, amount: r.amount, memo: r.memo }; });
        var ans = await callClaude(MODEL_REVIEW, blobs, REVIEW + '\n' + JSON.stringify(items));
        ans.forEach(function (a) {
          if (!a || typeof a !== 'object') return;
          var i = toInt(String(a.ref || '').replace(/^a/, '')); if (targets.indexOf(i) < 0) return;
          var r = rows[i], v = clean(a), agreed = v.no === r.no && v.amount === r.amount && v.name === r.name;
          if (v.no !== null) r.no = v.no; if (v.amount !== null) r.amount = v.amount; if (v.name) r.name = v.name; if (v.memo) r.memo = v.memo;
          r.conf = agreed ? Math.max(v.conf, r.conf) : Math.min(v.conf, r.conf); r.disagree = !agreed; r.reviewed = true;
          r.review = { no: v.no, name: v.name, amount: v.amount };
          var seen = {}; r.candidates = [r.name, r.first.name].concat(Array.isArray(a.alt_names) ? a.alt_names : []).map(function (n) { return String(n || '').slice(0, 40); })
            .filter(function (n) { if (!n || seen[n]) return false; seen[n] = 1; return true; }).slice(0, 3);
        });
      } catch (e) { if (e.code === 'auth') throw e; failed = true; }
    }
    return { rows: rows, reviewed: targets.length, failed: failed };
  }
  async function readAll() {
    if (S.busy) return;
    if (!apiKey()) { go('key'); return; }
    var todo = S.photos.filter(function (p) { return p.state === 'wait' || p.state === 'fail'; }); if (!todo.length) return;
    var PER = 4, read = 0, reviewed = 0, revFail = false, stop = '';
    S.busy = true;
    for (var i = 0; i < todo.length; i += PER) {
      var batch = todo.slice(i, i + PER);
      batch.forEach(function (p) { p.state = 'run'; p.found = 0; });
      S.status = { text: '사진 ' + todo.length + '장 중 ' + (i + 1) + '~' + Math.min(i + PER, todo.length) + '번째를 읽는 중… 애매한 봉투는 한 번 더 읽어서 30초~1분 걸릴 수 있어요.' }; render();
      try {
        var res = await readBatch(batch);
        res.rows.forEach(function (r) {
          var p = batch[r.photo - 1] || batch[0];
          S.rows.push({ id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), no: r.no, name: r.name, amount: r.amount, memo: r.memo, conf: r.conf,
            disagree: r.disagree, reviewed: r.reviewed, candidates: r.candidates, first: r.first, review: r.review || null, by: S.name || '', at: new Date().toISOString() });
          if (p) p.found++;
        });
        saveRows();
        read += res.rows.length; reviewed += res.reviewed; revFail = revFail || res.failed;
        batch.forEach(function (p) { p.state = 'done'; });
      } catch (e) {
        batch.forEach(function (p) { p.state = 'fail'; });
        stop = e.message || '읽는 중 문제가 생겼어요. 다시 눌러 주세요.'; break;
      }
    }
    S.busy = false;
    var rv = reviewed ? ' 그중 ' + reviewed + '장은 글씨가 애매해 오퍼스가 한 번 더 읽었어요.' : '';
    S.status = stop ? { kind: 'warn', text: (read ? '봉투 ' + read + '장까지 넣었어요.' + rv + ' ' : '') + stop }
      : { kind: revFail ? 'warn' : 'ok', text: '봉투 ' + read + '장을 장부에 넣었어요.' + rv + (revFail ? ' 다시 읽기가 일부 실패해 해당 봉투는 확인 필요로 남겼어요.' : '') };
    render();
  }

  /* ---------- 엑셀 ---------- */
  function excel() {
    if (typeof XLSX === 'undefined') { S.err = '엑셀 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'; render(); return; }
    var dup = dupMap(), t = totals();
    var table = [['번호', '이름', '금액(원)', '메모', '찍은 사람', '확인', '소넷 1차', '오퍼스 검토']];
    sorted().forEach(function (r) {
      table.push([r.no, r.name, r.amount === null ? null : r.amount * 10000, r.memo, r.by, reason(r, dup),
        r.first ? [r.first.no, r.first.name, r.first.amount].join(' / ') : '', r.review ? [r.review.no, r.review.name, r.review.amount].join(' / ') : '']);
    });
    table.push(['합계', t.count + '장', t.sum * 10000, '', '', '', '', '']);
    var ws = XLSX.utils.aoa_to_sheet(table);
    ws['!cols'] = [{ wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 10 }, { wch: 18 }, { wch: 20 }, { wch: 20 }];
    var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '축의금 장부');
    var buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    var url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    var a = document.createElement('a'); a.href = url; a.download = 'WeddingSCAN-ledger-' + todayStr() + '.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    S.status = { kind: 'ok', text: '엑셀 파일을 저장했어요. 휴대폰의 다운로드 폴더를 확인해 주세요.' };
  }

  /* ---------- 이벤트 ---------- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    var a = b.dataset.act;
    if (a === 'cam') $('camIn').click();
    else if (a === 'album') $('albumIn').click();
    else if (a === 'livecam') openLiveCam();
    else if (a === 'read') readAll();
    else if (a === 'go') go(b.dataset.val);
    else if (a === 'excel') excel();
    else if (a === 'delkey') { drop('ws-key'); S.status = { kind: 'ok', text: 'API 키를 지웠어요.' }; render(); }
    else if (a === 'relock') { drop('ws-unlock'); go('home'); }
    else if (a === 'wipe') {
      if (!S.wipeArmed) { S.wipeArmed = true; render(); setTimeout(function () { S.wipeArmed = false; if (currentView() === 'settings') render(); }, 3000); return; }
      S.wipeArmed = false; S.rows = []; saveRows(); S.photos.forEach(function (p) { URL.revokeObjectURL(p.url); }); S.photos = []; S.status = { kind: 'ok', text: '시험 장부를 비웠어요.' }; render();
    }
  });
  $('gearBtn').addEventListener('click', function () { if (currentView() !== 'settings') S.prev = currentView() === 'key' ? 'home' : S.view; go('settings'); });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'q') { S.q = e.target.value; var pos = e.target.selectionStart; render(); var q = $('q'); q.focus(); try { q.setSelectionRange(pos, pos); } catch (x) {} }
    if (e.target.id === 'cashIn') S.cash = e.target.value;
  });
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    var id = e.target.id;
    if (id === 'entryForm') {
      var pin = $('pin').value.trim(), nm = $('hname').value.trim();
      if (!/^\d{4}$/.test(pin)) { S.err = '비밀번호 숫자 4자리를 적어 주세요.'; render(); $('pin').focus(); return; }
      if (pin !== String(cfg().pin)) { S.err = '비밀번호가 맞지 않아요. 혼주님께 받은 숫자를 확인해 주세요.'; render(); $('pin').focus(); return; }
      S.name = nm; save('ws-name', nm); save('ws-unlock', unlockKey()); go('home');
    } else if (id === 'cashForm') { S.cash = $('cashIn').value; render(); }
    else if (id === 'keyForm') {
      var k = $('keyIn').value.trim();
      if (!/^sk-ant-/.test(k)) { S.err = 'sk-ant-로 시작하는 키를 붙여 넣어 주세요.'; render(); return; }
      save('ws-key', k); go('home'); readAll();
    } else if (id === 'cfgForm') {
      var next = { ledgerName: $('cLedger').value.trim() || DEFAULT_CFG.ledgerName, date: $('cDate').value || todayStr(), venue: $('cVenue').value.trim(), pin: $('cPin').value.trim(), alwaysOpen: $('cOpen').checked };
      if (!/^\d{4}$/.test(next.pin)) { S.err = '비밀번호는 숫자 4자리로 적어 주세요.'; render(); return; }
      save('ws-cfg', next); S.status = { kind: 'ok', text: '시험 설정을 저장했어요.' }; go(S.prev === 'settings' ? 'home' : S.prev);
    }
  });

  render();
})();
