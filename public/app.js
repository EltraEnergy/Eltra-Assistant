/* Eltra Today: standalone HUD dashboard with a voice assistant. */
(function () {
  'use strict';
  var TZ = 'Australia/Melbourne', RING = 2 * Math.PI * 76;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (d, o) { return d.toLocaleString('en-AU', Object.assign({ timeZone: TZ }, o)); };
  var dayKey = function (d) { return d.toLocaleDateString('en-CA', { timeZone: TZ }); };
  function load(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'X-Eltra': '1' };
    if (opts.body && !(opts.body instanceof Blob)) headers['Content-Type'] = 'application/json';
    if (opts.body instanceof Blob) headers['Content-Type'] = opts.body.type || 'audio/webm';
    return fetch('/.netlify/functions/' + path, { method: opts.method || 'GET', credentials: 'same-origin', headers: headers, body: opts.body ? (opts.body instanceof Blob ? opts.body : JSON.stringify(opts.body)) : undefined })
      .then(function (res) {
        if (opts.raw && res.ok) return res;
        return res.json().catch(function () { return {}; }).then(function (d) {
          if (res.status === 401 && path !== 'login') { showLogin(); throw new Error('Please log in again'); }
          if (!res.ok) { var e = new Error(d.error || (res.status === 502 || res.status === 504 ? 'That took too long. Try again.' : 'Error ' + res.status)); e.data = d; throw e; }
          return d;
        });
      });
  }

  // ================= login =================
  function showLogin() { $('appView').hidden = true; $('loginView').hidden = false; setTimeout(function () { $('pw').focus(); }, 50); }
  var started = false;
  function showApp() { $('loginView').hidden = true; $('appView').hidden = false; if (!started) { started = true; startApp(); } }
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault(); $('loginErr').textContent = '';
    api('login', { method: 'POST', body: { password: $('pw').value } }).then(function () { $('pw').value = ''; showApp(); }).catch(function (err) { $('loginErr').textContent = err.message; });
  });
  $('logout').onclick = function () { api('login', { method: 'DELETE' }).catch(function () {}).then(showLogin); };

  // ================= clock =================
  function tick() {
    var n = new Date(), h = +n.toLocaleString('en-AU', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
    $('clock').textContent = fmt(n, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    $('today').textContent = fmt(n, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' · Melbourne';
    $('greet').textContent = (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + ', Will.';
  }

  // ================= dashboard =================
  var D = null, events = [];
  function mapsLink(a) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(a); }
  function phone(p) { return '<span class="mono">' + esc(p) + '</span><button type="button" class="copy" data-copy="' + esc(p) + '">Copy</button>'; }
  function shortAddr(a) { return String(a || '').replace(/, Australia$/, ''); }
  function parseEvents(list) {
    return (list || []).map(function (e) {
      var start = e.all_day ? new Date(e.start_iso + 'T00:00:00') : new Date(e.start_iso), end = e.end_iso && !e.all_day ? new Date(e.end_iso) : null;
      return { title: e.title, start: start, end: end, allDay: e.all_day, location: e.location, who: e.customer, sale: e.sales_visit, link: e.link };
    }).sort(function (a, b) { return a.start - b.start; });
  }
  function setRing(text, label, frac) { $('ring').textContent = text; $('ringLbl').textContent = label; $('arc').setAttribute('stroke-dasharray', (Math.max(0, Math.min(1, frac)) * RING).toFixed(1) + ' ' + RING.toFixed(1)); }
  function renderNext() {
    if (!D || !D.calendar || D.calendar.error) return;
    var now = Date.now(), nx = events.filter(function (e) { return !e.allDay && (e.end ? e.end.getTime() : e.start.getTime()) > now; })[0];
    if (!nx) { $('nextTitle').textContent = 'Clear for the rest of the week'; $('nextMeta').innerHTML = ''; setRing('00:00', 'nothing booked', 0); return; }
    var mins = Math.round((nx.start.getTime() - now) / 60000);
    if (mins <= 0) setRing('LIVE', 'in progress', (now - nx.start.getTime()) / ((nx.end ? nx.end - nx.start : 3600e3)));
    else if (mins < 1440) setRing(String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0'), 'hrs : min to go', 1 - mins / 1440);
    else setRing(Math.floor(mins / 1440) + 'd', fmt(nx.start, { weekday: 'long' }), 0.04);
    $('nextTitle').innerHTML = esc(nx.who && nx.who.name ? nx.who.name : nx.title) + (nx.sale ? '<span class="tag sale">Sales</span>' : '');
    var b = ['<span class="mono" style="color:var(--cyan)">' + esc(fmt(nx.start, { weekday: 'short', day: 'numeric', month: 'short' })) + ' · ' + esc(fmt(nx.start, { hour: 'numeric', minute: '2-digit' })) + '</span>'];
    if (nx.location) b.push('<a href="' + mapsLink(nx.location) + '" target="_blank" rel="noopener">' + esc(shortAddr(nx.location)) + '</a>');
    if (nx.who && nx.who.phone) b.push('<span>' + phone(nx.who.phone) + '</span>');
    if (nx.who && nx.who.name && nx.title !== nx.who.name) b.push('<span class="sub">' + esc(nx.title) + '</span>');
    $('nextMeta').innerHTML = b.join('');
  }
  function section(r, el, none, render) {
    if (!r) return false;
    if (r.error) { $(el).innerHTML = '<p class="note err">// ' + esc(r.error) + '</p>'; return false; }
    if (!r.data.length) { $(el).innerHTML = '<p class="note">// ' + esc(none) + '</p>'; return true; }
    $(el).innerHTML = render(r.data); return true;
  }
  function renderAll() {
    var s = D.status || {}, g = s.google || {}, stamp = 'Synced ' + fmt(new Date(D.at), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    var dot = function (on, label, link) { return '<span><i class="dot ' + (on === true ? 'on' : on === 'warn' ? 'warn' : '') + '"></i>' + label + '</span>'; };
    var googleDot = !g.setUp ? dot(false, 'Google') : !g.connected ? '<span><i class="dot warn"></i><a href="/.netlify/functions/google-auth?start=1">Connect Google</a></span>' : dot(D.calendar && D.calendar.error ? 'warn' : true, 'Google');
    $('sys').innerHTML = googleDot + dot(s.ghl, 'GoHighLevel') + dot(s.sm8, 'ServiceM8') + dot(s.voice, 'Voice');

    // calendar
    if (!g.connected) { var msg = g.setUp ? 'Tap Connect Google at the top to load your calendar and email.' : 'Google isn’t set up yet. See SETUP.md.'; $('cal').innerHTML = $('mail').innerHTML = '<p class="note">// ' + msg + '</p>'; $('nextTitle').textContent = 'Calendar offline'; setRing('--', 'offline', 0); }
    if (D.calendar && !D.calendar.error) events = parseEvents(D.calendar.data);
    section(D.calendar, 'cal', 'No bookings in the next 7 days.', function () {
      var today = dayKey(new Date()), tom = dayKey(new Date(Date.now() + 864e5)), now = Date.now(), h = '', cur = null;
      events.forEach(function (e) {
        var k = dayKey(e.start);
        if (k !== cur) { if (cur) h += '</div>'; cur = k; h += '<div class="day"><h4>' + (k === today ? '<span class="today">Today</span>' : k === tom ? 'Tomorrow' : esc(fmt(e.start, { weekday: 'long' }))) + ' · ' + esc(fmt(e.start, { day: '2-digit', month: 'short' })) + '</h4>'; }
        var endT = e.end ? e.end.getTime() : e.start.getTime(), past = !e.allDay && endT < now, live = !e.allDay && e.start.getTime() <= now && endT > now;
        var d = [];
        if (e.location) d.push('<a href="' + mapsLink(e.location) + '" target="_blank" rel="noopener">' + esc(shortAddr(e.location)) + '</a>');
        if (e.who && e.who.phone) d.push('<span>' + phone(e.who.phone) + '</span>');
        h += '<div class="ev' + (past ? ' past' : '') + (live ? ' now' : e.sale ? ' sale' : '') + '"><time>' + (e.allDay ? 'ALL DAY' : esc(fmt(e.start, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))) + (!e.allDay && e.end ? '<small>' + Math.round((e.end - e.start) / 60000) + ' MIN</small>' : '') + '</time><div><div class="t"><a href="' + esc(e.link) + '" target="_blank" rel="noopener">' + esc(e.title) + '</a>' + (e.sale ? '<span class="tag sale">Sales</span>' : '') + '</div>' + (d.length ? '<div class="d">' + d.join('') + '</div>' : '') + '</div></div>';
      });
      return h + '</div>';
    });
    if (D.calendar) $('calStamp').textContent = D.calendar.error ? 'Sync failed' : stamp;
    renderNext();

    // email
    var mail = D.mail && !D.mail.error ? D.mail.data : [];
    section(D.mail, 'mail', 'No new email in the last 7 days. Newsletters and social are filtered out.', function (list) {
      return '<ul class="list">' + list.map(function (t) {
        var who = t.last_from_will ? 'You' : String(t.from || '').replace(/<.*>/, '').replace(/"/g, '').trim() || t.from, when = t.date_iso ? new Date(t.date_iso) : null;
        return '<li class="' + (t.unread ? 'unread' : '') + '"><button type="button" class="row" data-say="Read me the email conversation &quot;' + esc(t.subject) + '&quot; (thread ' + esc(t.thread_id) + ') and tell me if it needs anything from me.">' +
          '<div class="r1"><span class="who">' + esc(who) + (t.messages > 1 ? ' [' + t.messages + ']' : '') + '</span><span class="dt">' + (when ? esc((dayKey(when) === dayKey(new Date()) ? fmt(when, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : fmt(when, { weekday: 'short', day: '2-digit', month: 'short' })).toUpperCase()) : '') + '</span></div>' +
          '<div class="s">' + esc(t.subject || '(no subject)') + (t.last_from_will ? '<span class="tag wait">Replied</span>' : '<span class="tag reply">Reply</span>') + '</div>' + (t.snippet ? '<div class="sn">' + esc(t.snippet) + '</div>' : '') + '</button></li>';
      }).join('') + '</ul>';
    });
    if (D.mail) $('mailStamp').textContent = D.mail.error ? 'Sync failed' : stamp;

    // stats
    if (D.calendar && !D.calendar.error) {
      var today = dayKey(new Date());
      $('sToday').textContent = events.filter(function (e) { return !e.allDay && dayKey(e.start) === today; }).length;
      $('sSales').textContent = events.filter(function (e) { return e.sale; }).length;
    }
    if (D.mail && !D.mail.error) $('sReply').textContent = mail.filter(function (t) { return !t.last_from_will; }).length;
    if (D.leads && !D.leads.error) $('sLeads').textContent = D.leads.data.length;
    else if (!s.ghl) { $('sLeads').textContent = D.jobs && !D.jobs.error ? D.jobs.data.length : '–'; $('sLeadsLbl').textContent = D.jobs ? 'Jobs booked this week' : 'Open leads'; }

    // leads + jobs
    if (!s.ghl) $('leads').innerHTML = '<p class="note">// Offline. Add GHL_TOKEN and GHL_LOCATION_ID in Netlify to connect GoHighLevel.</p>';
    else section(D.leads, 'leads', 'No open leads.', function (list) {
      return '<ul class="list">' + list.map(function (o) { return '<li><button type="button" class="row" data-say="What’s the latest with the lead ' + esc(o.name || '') + ' (opportunity ' + esc(o.id) + ')? What should I do next?"><div class="r1"><span class="who">' + esc(o.stage || '') + '</span><span class="dt">' + esc(String(o.updated || '').toUpperCase()) + '</span></div><div class="s">' + esc(o.name || (o.contact && o.contact.name) || 'Lead') + '</div>' + (o.contact && o.contact.phone ? '<div class="sn">' + esc(o.contact.phone) + '</div>' : '') + '</button></li>'; }).join('') + '</ul>';
    });
    if (!s.sm8) $('jobs').innerHTML = '<p class="note">// Offline. Add SERVICEM8_API_KEY in Netlify to connect ServiceM8.</p>';
    else section(D.jobs, 'jobs', 'Nothing booked in the next 7 days.', function (list) {
      return '<ul class="list">' + list.map(function (j) { var job = j.job || {}, m = String(j.start || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/), when = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
        return '<li><button type="button" class="row" data-say="Tell me about ServiceM8 job ' + esc(job.job_no ? '#' + job.job_no : job.uuid) + ' at ' + esc(job.address || '') + '."><div class="r1"><span class="who">' + esc([job.job_no && '#' + job.job_no, job.status, j.staff].filter(Boolean).join(' · ')) + '</span><span class="dt">' + (when ? esc(when.toLocaleString('en-AU', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).toUpperCase()) : '') + '</span></div><div class="s">' + esc(job.address || 'Job') + '</div>' + (job.description ? '<div class="sn">' + esc(job.description) + '</div>' : '') + '</button></li>'; }).join('') + '</ul>';
    });
  }
  var todayTimer = null;
  function loadToday() {
    clearTimeout(todayTimer); todayTimer = setTimeout(loadToday, 3 * 60000);
    return api('today').then(function (d) { D = d; renderAll(); }).catch(function (e) { $('cal').innerHTML = '<p class="note err">// ' + esc(e.message) + '</p>'; });
  }
  document.addEventListener('click', function (e) {
    var c = e.target.closest('[data-copy]');
    if (c) { var t = c.dataset.copy; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { c.textContent = 'Copied'; setTimeout(function () { c.textContent = 'Copy'; }, 1500); }, function () {}); return; }
    var r = e.target.closest('.list [data-say]'); if (r) { ask(r.dataset.say); $('log').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  });

  // ================= chat (agent with approvals) =================
  var CHAT = 'eltra-hud-chat-v1';
  var chat = load(CHAT, null) || { messages: [], approvals: null, results: {}, decided: {} };
  var busy = false, lastError = null, steps = 0, aborted = false;
  var LABELS = { gmail_search: 'Searching email', gmail_read: 'Reading email', gmail_create_draft: 'Drafting email', gmail_send_draft: 'Sending email', gmail_archive: 'Archiving email', gmail_save_attachments: 'Saving attachments', calendar_events: 'Checking calendar', calendar_create_event: 'Adding to calendar', drive_search: 'Searching Drive', drive_list_folder: 'Opening folder', drive_move: 'Moving files', drive_create_folder: 'Creating folder', drive_rename: 'Renaming', ghl_pipelines: 'Checking pipeline', ghl_search_opportunities: 'Looking up leads', ghl_search_contacts: 'Looking up contacts', ghl_move_opportunity: 'Updating lead', ghl_add_note: 'Adding note', ghl_add_task: 'Adding task', sm8_jobs: 'Looking up jobs', sm8_schedule: 'Checking schedule', sm8_add_job_note: 'Adding job note', sm8_create_job: 'Creating job' };
  function persist() { save(CHAT, chat); }
  function md(t) {
    var out = '', inList = false;
    esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split('\n').forEach(function (l) {
      var m = l.match(/^\s*(?:[-•*]|\d+\.)\s+(.*)$/);
      if (m) { if (!inList) { out += '<ul>'; inList = true; } out += '<li>' + m[1] + '</li>'; return; }
      if (inList) { out += '</ul>'; inList = false; }
      if (l.trim()) out += '<p>' + l + '</p>';
    });
    return out + (inList ? '</ul>' : '');
  }
  function render() {
    var h = '';
    if (!chat.messages.length) h = '<div class="empty">// Ask about your day, your email, a customer or a job</div>';
    chat.messages.forEach(function (m) {
      if (m.role === 'user') { if (typeof m.content === 'string') h += '<div class="m you">' + esc(m.content) + '</div>'; return; }
      (m.content || []).forEach(function (c) {
        if (c.type === 'text' && c.text.trim()) h += '<div class="m ai">' + md(c.text) + '</div>';
        else if (c.type === 'tool_use') {
          var r = chat.results[c.id];
          if (r) h += '<div class="card done"><div class="ch">' + esc(r.title) + '</div><div class="res ' + (r.ok ? 'ok' : 'no') + '">' + (r.ok ? '✓ Approved' : '✕ Cancelled') + '</div></div>';
          else if (!(chat.approvals || []).some(function (a) { return a.id === c.id; })) h += '<div class="act">' + esc(LABELS[c.name] || c.name) + (c.name === 'gmail_create_draft' && c.input ? ' · to ' + esc(c.input.to) : '') + '</div>';
        }
      });
    });
    (chat.approvals || []).forEach(function (a) {
      h += '<div class="card"><div class="ch">Needs your OK</div><div><b>' + esc(a.title) + '</b></div>' + (a.lines || []).map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('') + (a.preview ? '<pre>' + esc(a.preview) + '</pre>' : '') +
        '<div class="row"><button type="button" class="btn go" data-ok="' + esc(a.id) + '">Approve</button><button type="button" class="btn no" data-no="' + esc(a.id) + '">Cancel</button></div></div>';
    });
    if (busy) h += '<div class="act wait">Working…</div>';
    if (lastError) h += '<div class="m err"><span>' + esc(lastError) + '</span><button type="button" class="copy" id="retry">Try again</button></div>';
    $('log').innerHTML = h; $('log').scrollTop = $('log').scrollHeight;
    var r = $('retry'); if (r) r.onclick = function () { lastError = null; step({}); };
    $('sendBtn').disabled = busy; $('stop').hidden = !busy;
  }
  $('log').addEventListener('click', function (e) {
    var ok = e.target.closest('[data-ok]'), no = e.target.closest('[data-no]'); if (!ok && !no) return;
    unlockAudio();
    var id = (ok || no).dataset.ok || (ok || no).dataset.no, a = (chat.approvals || []).filter(function (x) { return x.id === id; })[0]; if (!a) return;
    chat.decided[id] = !!ok; chat.results[id] = { title: a.title, ok: !!ok };
    chat.approvals = chat.approvals.filter(function (x) { return x.id !== id; }); persist(); render();
    if (!chat.approvals.length) { var d = chat.decided; chat.decided = {}; chat.approvals = null; step(d); }
  });
  function ask(text) {
    text = String(text || '').trim(); if (!text || busy) return;
    unlockAudio(); hush();
    $('askIn').value = '';
    if (chat.approvals && chat.approvals.length) { var d = {}; chat.approvals.forEach(function (a) { d[a.id] = false; chat.results[a.id] = { title: a.title, ok: false }; }); chat.approvals = null; chat.pending = text; persist(); step(d); return; }
    chat.messages.push({ role: 'user', content: text }); persist(); step({});
  }
  function step(decisions) {
    busy = true; aborted = false; lastError = null; setState('thinking', 'Thinking'); render();
    api('agent', { method: 'POST', body: { messages: chat.messages, decisions: decisions } }).then(function (d) {
      if (aborted) return;
      chat.messages = d.messages || chat.messages;
      if (d.state === 'approval') { chat.approvals = d.approvals; busy = false; steps = 0; persist(); render(); setState('idle', 'Awaiting OK'); speak('I need your OK for ' + (d.approvals.length === 1 ? 'this.' : 'these.')); return; }
      if (d.acted && d.acted.length) setTimeout(loadToday, 1500);
      if (d.state === 'continue' && steps++ < 12) { persist(); render(); step({}); return; }
      busy = false; steps = 0; persist();
      if (chat.pending) { var t = chat.pending; chat.pending = null; ask(t); return; }
      render();
      var last = chat.messages[chat.messages.length - 1];
      var text = last && last.role === 'assistant' ? (last.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join(' ') : '';
      if (text) speak(text, true); else setState('idle', 'Standby');
    }).catch(function (e) {
      if (aborted) return;
      if (e.data && e.data.messages) chat.messages = e.data.messages;
      busy = false; steps = 0; lastError = e.message; persist(); render(); setState('idle', 'Standby');
    });
  }
  $('askForm').addEventListener('submit', function (e) { e.preventDefault(); armed = false; ask($('askIn').value); });
  $('chips').addEventListener('click', function (e) { var b = e.target.closest('[data-say]'); if (b) ask(b.dataset.say); });
  $('stop').onclick = function () { aborted = true; busy = false; steps = 0; hush(); stopListening(true); setState('idle', 'Standby'); render(); };
  $('clear').onclick = function () { if (busy) return; chat = { messages: [], approvals: null, results: {}, decided: {} }; lastError = null; persist(); render(); hush(); };

  // ================= voice out =================
  var orb = $('orb'), player = new Audio(), unlocked = false, voices = null, vs = load('eltra-hud-voice', {}), speaking = false, speakUrl = null;
  player.setAttribute('playsinline', '');
  function setState(st, label) { orb.dataset.state = st; $('vState').textContent = label; }
  function silentWav() {
    var b = new ArrayBuffer(46), v = new DataView(b), w = function (o, t) { for (var i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 38, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, 2, true); v.setInt16(44, 0, true);
    return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  }
  function unlockAudio() {
    if (unlocked) return; unlocked = true;
    try { player.src = silentWav(); player.play().catch(function () {}); } catch (e) {}
    try { if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch (e) {}
  }
  function hush() { speaking = false; try { player.pause(); } catch (e) {} try { speechSynthesis.cancel(); } catch (e) {} }
  function clean(t) { return String(t).replace(/\*\*/g, '').replace(/^\s*[-•*]\s+/gm, '').replace(/https?:\/\/\S+/g, 'the link').slice(0, 1800); }
  function afterSpeech(fromReply) { speaking = false; if (busy) return; setState('idle', 'Standby'); if (fromReply && $('convo').checked && canRecord) setTimeout(function () { if (!busy && !speaking) startListening(); }, 350); }
  function speak(text, fromReply) {
    if (!$('speak').checked || !text) { afterSpeech(fromReply); return; }
    hush(); speaking = true; setState('speaking', 'Speaking');
    var useEleven = voices && voices.configured && vs.engine !== 'device';
    if (!useEleven) return deviceSpeak(text, fromReply);
    api('speak', { method: 'POST', body: { text: clean(text), voice_id: vs.voice || voices.default, speed: +$('rate').value || 1 }, raw: true })
      .then(function (res) { return res.blob(); })
      .then(function (blob) {
        if (!speaking) return;
        if (speakUrl) URL.revokeObjectURL(speakUrl);
        speakUrl = URL.createObjectURL(blob); player.src = speakUrl;
        player.onended = function () { afterSpeech(fromReply); };
        player.onerror = function () { deviceSpeak(text, fromReply); };
        return player.play().catch(function () { deviceSpeak(text, fromReply); });
      })
      .catch(function () { if (speaking) deviceSpeak(text, fromReply); });
  }
  function deviceVoice() { var v = ('speechSynthesis' in window) ? speechSynthesis.getVoices() : []; return v.filter(function (x) { return (x.voiceURI || x.name) === vs.device; })[0] || v.filter(function (x) { return /en-AU/i.test(x.lang); })[0] || v.filter(function (x) { return /^en/i.test(x.lang); })[0] || null; }
  function deviceSpeak(text, fromReply) {
    if (!('speechSynthesis' in window)) { afterSpeech(fromReply); return; }
    var u = new SpeechSynthesisUtterance(clean(text)), v = deviceVoice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-AU';
    u.rate = +$('rate').value || 1; u.onend = u.onerror = function () { afterSpeech(fromReply); };
    speaking = true; setState('speaking', 'Speaking'); speechSynthesis.speak(u);
  }
  function fillVoices() {
    var sel = $('voiceSel'), h = '';
    if (voices && voices.configured && voices.voices.length) {
      h += '<optgroup label="ElevenLabs">' + voices.voices.map(function (v) { return '<option value="el:' + esc(v.id) + '">' + esc(v.name + [v.accent, v.gender].filter(Boolean).map(function (x) { return ' · ' + x; }).join('')) + '</option>'; }).join('') + '</optgroup>';
    }
    var dv = ('speechSynthesis' in window) ? speechSynthesis.getVoices().filter(function (v) { return /^en/i.test(v.lang); }) : [];
    if (dv.length) h += '<optgroup label="This device">' + dv.map(function (v) { return '<option value="dv:' + esc(v.voiceURI || v.name) + '">' + esc(v.name + ' · ' + v.lang) + '</option>'; }).join('') + '</optgroup>';
    sel.innerHTML = h || '<option>Device default</option>';
    sel.value = vs.engine === 'device' && vs.device ? 'dv:' + vs.device : 'el:' + (vs.voice || (voices && voices.default) || '');
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
    $('voiceNote').textContent = voices && voices.configured ? (voices.error ? 'ElevenLabs: ' + voices.error : 'Add more voices in your ElevenLabs Voice Library and they appear here.') : 'Add ELEVENLABS_API_KEY in Netlify for natural voices.';
  }
  $('voiceSel').onchange = function () { var v = $('voiceSel').value; if (v.indexOf('el:') === 0) { vs.engine = 'eleven'; vs.voice = v.slice(3); } else { vs.engine = 'device'; vs.device = v.slice(3); } save('eltra-hud-voice', vs); };
  if (vs.rate) $('rate').value = vs.rate;
  var showRate = function () { $('rateV').textContent = (+$('rate').value).toFixed(2) + '×'; }; showRate();
  $('rate').oninput = function () { vs.rate = +$('rate').value; save('eltra-hud-voice', vs); showRate(); };
  $('speak').checked = vs.speak !== false; $('speak').onchange = function () { vs.speak = $('speak').checked; save('eltra-hud-voice', vs); if (!$('speak').checked) hush(); };
  $('convo').checked = !!vs.convo; $('convo').onchange = function () { vs.convo = $('convo').checked; save('eltra-hud-voice', vs); };
  $('testVoice').onclick = function () { unlockAudio(); var was = $('speak').checked; $('speak').checked = true; speak('G’day Will. This is how I’ll sound when I read out your brief.'); $('speak').checked = was; };
  try { speechSynthesis.addEventListener('voiceschanged', fillVoices); } catch (e) {}

  // ================= voice in: record, stop on silence, transcribe =================
  var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  var stream = null, recorder = null, chunks = [], listening = false, vad = null, ac = null, cancelRec = false, forceSend = false;
  function mimeType() { var t = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']; for (var i = 0; i < t.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t[i])) return t[i]; return ''; }
  function stopListening(cancel, manual) { cancelRec = !!cancel; forceSend = !!manual; if (recorder && recorder.state !== 'inactive') recorder.stop(); }
  function startListening() {
    if (listening || busy) return;
    hush(); unlockAudio();
    if (!canRecord || !(voices && voices.configured)) return startFallback();
    cancelRec = false;
    var go = stream ? Promise.resolve(stream) : navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    go.then(function (s) {
      stream = s; chunks = [];
      var mt = mimeType(); recorder = new MediaRecorder(s, mt ? { mimeType: mt } : undefined);
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = function () {
        listening = false; clearInterval(vad); orb.style.removeProperty('--lvl');
        var blob = new Blob(chunks, { type: (recorder.mimeType || 'audio/webm').split(';')[0] });
        if (cancelRec || !(heard || forceSend) || blob.size < 1500) { setState('idle', 'Standby'); return; }
        setState('thinking', 'Transcribing');
        api('listen', { method: 'POST', body: blob }).then(function (d) {
          if (d.text && d.text.trim().length > 1) ask(d.text); else { setState('idle', 'Didn’t catch that'); }
        }).catch(function (e) { setState('idle', 'Standby'); lastError = 'Couldn’t hear that: ' + e.message; render(); });
      };
      // simple voice activity detection: wait for speech, then stop after ~1.4 s of quiet
      if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      var src = ac.createMediaStreamSource(s), an = ac.createAnalyser(); an.fftSize = 1024; src.connect(an);
      var buf = new Uint8Array(an.fftSize), heard = false, quietSince = 0, startAt = Date.now(), floor = 0.012;
      vad = setInterval(function () {
        an.getByteTimeDomainData(buf); var sum = 0; for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
        var rms = Math.sqrt(sum / buf.length), now = Date.now();
        orb.style.setProperty('--lvl', Math.min(14, rms * 120).toFixed(1) + 'px');
        if (now - startAt < 400) { floor = Math.max(floor, rms * 1.8); return; }
        if (rms > Math.max(0.02, floor)) { heard = true; quietSince = 0; }
        else if (heard) { if (!quietSince) quietSince = now; if (now - quietSince > 1400) stopListening(false); }
        if (!heard && now - startAt > 8000) stopListening(true);
        if (now - startAt > 45000) stopListening(false);
      }, 80);
      recorder.start(250); listening = true; setState('listening', 'Listening');
    }).catch(function (e) { canRecord = false; $('vHint').textContent = 'Microphone blocked. Allow it in your browser settings, or use the keyboard mic.'; startFallback(); });
  }
  // fallback 1: browser speech recognition; fallback 2: keyboard dictation with auto-send
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition, armed = false, quiet = null;
  function startFallback() {
    if (SR) {
      try {
        var rec = new SR(), text = ''; rec.lang = 'en-AU'; rec.interimResults = true;
        rec.onresult = function (e) { text = ''; for (var i = 0; i < e.results.length; i++) text += e.results[i][0].transcript; $('askIn').value = text; };
        rec.onerror = function () { SR = null; };
        rec.onend = function () { listening = false; if (busy) return; setState('idle', 'Standby'); if (text.trim()) ask(text); };
        rec.start(); listening = true; setState('listening', 'Listening'); return;
      } catch (e) { SR = null; }
    }
    $('askIn').value = ''; $('askIn').focus(); armed = true; setState('listening', 'Dictate now');
    $('vHint').textContent = 'Use the mic key on your keyboard. It sends when you stop.';
  }
  $('askIn').addEventListener('input', function () { clearTimeout(quiet); if (!armed || busy) return; quiet = setTimeout(function () { if (armed && $('askIn').value.trim()) { armed = false; ask($('askIn').value); } }, 2200); });
  $('askIn').addEventListener('keydown', function (e) { if (e.key !== 'Enter' && e.key !== 'Unidentified') armed = false; });
  $('askIn').addEventListener('blur', function () { clearTimeout(quiet); armed = false; if (!busy && orb.dataset.state === 'listening' && !listening) setState('idle', 'Standby'); });
  orb.onclick = function () { unlockAudio(); if (busy) return; if (speaking) { hush(); setState('idle', 'Standby'); return; } if (listening) { stopListening(false, true); return; } startListening(); };
  document.addEventListener('keydown', function (e) { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); orb.click(); } });

  // ================= start =================
  function startApp() {
    tick(); setInterval(tick, 1000); setInterval(renderNext, 30000);
    render(); loadToday();
    api('speak').then(function (d) { voices = d; fillVoices(); }).catch(function () { voices = { configured: false }; fillVoices(); });
    if (/google=connected/.test(location.search)) history.replaceState(null, '', '/');
  }
  api('login').then(function (d) { if (d.loggedIn) showApp(); else showLogin(); }).catch(showLogin);
})();
