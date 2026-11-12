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
    if (!nx) { $('nextTitle').textContent = 'Nothing else booked this week'; $('nextMeta').innerHTML = ''; setRing('00:00', 'nothing booked', 0); return; }
    var mins = Math.round((nx.start.getTime() - now) / 60000);
    if (mins <= 0) setRing('Now', 'in progress', (now - nx.start.getTime()) / ((nx.end ? nx.end - nx.start : 3600e3)));
    else if (mins < 1440) setRing(String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0'), 'hours to go', 1 - mins / 1440);
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
    if (r.error) { $(el).innerHTML = '<p class="note err">' + esc(r.error) + '</p>'; return false; }
    if (!r.data.length) { $(el).innerHTML = '<p class="note">' + esc(none) + '</p>'; return true; }
    $(el).innerHTML = render(r.data); return true;
  }
  function renderAll() {
    var s = D.status || {}, g = s.google || {}, stamp = 'Synced ' + fmt(new Date(D.at), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    var dot = function (on, label, link) { return '<span><i class="dot ' + (on === true ? 'on' : on === 'warn' ? 'warn' : '') + '"></i>' + label + '</span>'; };
    var googleDot = !g.setUp ? dot(false, 'Google') : !g.connected ? '<span><i class="dot warn"></i><a href="/.netlify/functions/google-auth?start=1">Connect Google</a></span>' : dot(D.calendar && D.calendar.error ? 'warn' : true, 'Google');
    $('sys').innerHTML = googleDot + dot(s.ghl, 'GoHighLevel') + dot(s.sm8, 'ServiceM8') + dot(s.voice, 'Voice');
    var sl = systemsLine(), allUp = sl === 'All systems are up.';
    $('sysPill').innerHTML = '<i class="dot ' + (allUp ? 'on' : 'warn') + '"></i><span>' + esc(allUp ? 'All systems up' : sl.replace(/^All systems are up, except (.*)\.$/, '$1 not connected')) + '</span>';

    // calendar
    if (!g.connected) { var msg = g.setUp ? 'Tap Connect Google at the top to load your calendar and email.' : 'Google isn’t set up yet. See SETUP.md.'; $('cal').innerHTML = $('mail').innerHTML = '<p class="note">' + msg + '</p>'; $('nextTitle').textContent = 'Calendar not connected'; setRing('--', 'not connected', 0); }
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
        h += '<div class="ev' + (past ? ' past' : '') + (live ? ' now' : e.sale ? ' sale' : '') + '"><time>' + (e.allDay ? 'All day' : esc(fmt(e.start, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))) + (!e.allDay && e.end ? '<small>' + Math.round((e.end - e.start) / 60000) + ' min</small>' : '') + '</time><div><div class="t"><a href="' + esc(e.link) + '" target="_blank" rel="noopener">' + esc(e.title) + '</a>' + (e.sale ? '<span class="tag sale">Sales</span>' : '') + '</div>' + (d.length ? '<div class="d">' + d.join('') + '</div>' : '') + '</div></div>';
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
          '<div class="r1"><span class="who">' + esc(who) + (t.messages > 1 ? ' [' + t.messages + ']' : '') + '</span><span class="dt">' + (when ? esc((dayKey(when) === dayKey(new Date()) ? fmt(when, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : fmt(when, { weekday: 'short', day: '2-digit', month: 'short' }))) : '') + '</span></div>' +
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
    if (!s.ghl) $('leads').innerHTML = '<p class="note">Not connected yet. Add GHL_TOKEN and GHL_LOCATION_ID in Netlify to connect GoHighLevel.</p>';
    else section(D.leads, 'leads', 'No open leads.', function (list) {
      return '<ul class="list">' + list.map(function (o) { return '<li><button type="button" class="row" data-say="What’s the latest with the lead ' + esc(o.name || '') + ' (opportunity ' + esc(o.id) + ')? What should I do next?"><div class="r1"><span class="who">' + esc(o.stage || '') + '</span><span class="dt">' + esc(String(o.updated || '')) + '</span></div><div class="s">' + esc(o.name || (o.contact && o.contact.name) || 'Lead') + '</div>' + (o.contact && o.contact.phone ? '<div class="sn">' + esc(o.contact.phone) + '</div>' : '') + '</button></li>'; }).join('') + '</ul>';
    });
    if (!s.sm8) $('jobs').innerHTML = '<p class="note">Not connected yet. Add SERVICEM8_API_KEY in Netlify to connect ServiceM8.</p>';
    else section(D.jobs, 'jobs', 'Nothing booked in the next 7 days.', function (list) {
      return '<ul class="list">' + list.map(function (j) { var job = j.job || {}, m = String(j.start || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/), when = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
        return '<li><button type="button" class="row" data-say="Tell me about ServiceM8 job ' + esc(job.job_no ? '#' + job.job_no : job.uuid) + ' at ' + esc(job.address || '') + '."><div class="r1"><span class="who">' + esc([job.job_no && '#' + job.job_no, job.status, j.staff].filter(Boolean).join(' · ')) + '</span><span class="dt">' + (when ? esc(when.toLocaleString('en-AU', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })) : '') + '</span></div><div class="s">' + esc(job.address || 'Job') + '</div>' + (job.description ? '<div class="sn">' + esc(job.description) + '</div>' : '') + '</button></li>'; }).join('') + '</ul>';
    });
  }
  var todayTimer = null;
  function loadToday() {
    clearTimeout(todayTimer); todayTimer = setTimeout(loadToday, 3 * 60000);
    return api('today').then(function (d) { D = d; renderAll(); }).catch(function (e) { $('cal').innerHTML = '<p class="note err">' + esc(e.message) + '</p>'; });
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
  var LABELS = { gmail_search: 'Searching email', gmail_read: 'Reading email', gmail_create_draft: 'Drafting email', gmail_send_draft: 'Sending email', gmail_archive: 'Archiving email', gmail_save_attachments: 'Saving attachments', calendar_events: 'Checking calendar', calendar_create_event: 'Adding to calendar', drive_search: 'Searching Drive', sheets_read: 'Reading sheet', drive_read_file: 'Reading file', drive_list_folder: 'Opening folder', drive_move: 'Moving files', drive_create_folder: 'Creating folder', drive_rename: 'Renaming', ghl_pipelines: 'Checking pipeline', ghl_search_opportunities: 'Looking up leads', ghl_search_contacts: 'Looking up contacts', ghl_move_opportunity: 'Updating lead', ghl_add_note: 'Adding note', ghl_add_task: 'Adding task', sm8_jobs: 'Looking up jobs', sm8_schedule: 'Checking schedule', sm8_add_job_note: 'Adding job note', sm8_create_job: 'Creating job' };
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
    if (!chat.messages.length) h = '<div class="empty">Ask about your day, your email, a customer or a job</div>';
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
  function voiceAnswer(text) {
    var t = String(text).toLowerCase().replace(/[’']/g, '').replace(/[^a-z\s]/g, ' ').replace(/\b(eltra|el tra|elta|electra|ultra|altra|please|mate|thanks|thank you)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.split(' ').length > 5) return null;
    if (/^(yes|yeah|yep|yup|approve|approved|approve it|approve that|approve them|approve all|go ahead|do it|send it|send|ok|okay|confirm|confirmed|sure|go|looks good|thats fine|all good)( (yes|go ahead|do it|send it|approve|approve it|thats fine|all good|then))*$/.test(t)) return true;
    if (/^(no|nope|nah|cancel|cancel it|cancel that|cancel them|dont|dont do it|dont send it|do not|stop|decline|hold off|not yet|leave it)( (no|cancel|cancel it|thanks|for now|then))*$/.test(t)) return false;
    return null;
  }
  function decideAll(ok) {
    var d = chat.decided || {};
    (chat.approvals || []).forEach(function (a) { d[a.id] = ok; chat.results[a.id] = { title: a.title, ok: ok }; });
    chat.decided = {}; chat.approvals = null; persist(); render(); step(d);
  }
  // Follow-up listening only when Eltra's reply ends with a question, so it doesn't pick up the room.
  function asksSomething(t) { return /\?[\s"”’')]*$/.test(String(t).replace(/\s+$/, '')); }
  function ask(text) {
    wakeStop();
    if (SLEEP_RE.test(String(text).replace(/\b(eltra|el tra|elta|electra|ultra|altra)\b[\s,.!?]*/gi, '').trim())) { goSleep(); return; }
    text = String(text || '').trim(); if (!text || busy) return;
    unlockAudio(); hush();
    $('askIn').value = '';
    if (chat.approvals && chat.approvals.length) {
      // Spoken or typed approval: a short "approve", "yes, send it", "go ahead"… approves everything waiting;
      // "cancel", "no"… cancels it. Anything longer cancels and is treated as a new request, as before.
      var said = voiceAnswer(text);
      if (said !== null) { decideAll(said); if (!said) speak('Cancelled.'); return; }
      var d = {}; chat.approvals.forEach(function (a) { d[a.id] = false; chat.results[a.id] = { title: a.title, ok: false }; }); chat.approvals = null; chat.pending = text; persist(); step(d); return;
    }
    chat.messages.push({ role: 'user', content: text }); persist(); step({});
  }
  function step(decisions) {
    busy = true; aborted = false; lastError = null; setState('thinking', 'Thinking'); render();
    api('agent', { method: 'POST', body: { messages: chat.messages, decisions: decisions } }).then(function (d) {
      if (aborted) return;
      chat.messages = d.messages || chat.messages;
      if (d.state === 'approval') { chat.approvals = d.approvals; busy = false; steps = 0; persist(); render(); openDrawer('chat'); setState('idle', 'Awaiting OK'); speak('Needs your OK: ' + d.approvals.map(function (a) { return a.title; }).join(', and ') + '. Say approve or cancel.', true); return; }
      if (d.acted && d.acted.length) setTimeout(loadToday, 1500);
      if (d.state === 'continue' && steps++ < 12) { persist(); render(); step({}); return; }
      busy = false; steps = 0; persist();
      if (chat.pending) { var t = chat.pending; chat.pending = null; ask(t); return; }
      render();
      var last = chat.messages[chat.messages.length - 1];
      var text = last && last.role === 'assistant' ? (last.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join(' ') : '';
      if (text && !$('speak').checked) openDrawer('chat'); else if (text && $('chatDrawer').hidden) $('chatBtn').classList.add('has');
      if (text) speak(text, asksSomething(text)); else setState('idle', 'Ready');
    }).catch(function (e) {
      if (aborted) return;
      if (e.data && e.data.messages) chat.messages = e.data.messages;
      busy = false; steps = 0; lastError = e.message; persist(); render(); setState('idle', 'Ready'); openDrawer('chat');
    });
  }
  $('askForm').addEventListener('submit', function (e) { e.preventDefault(); armed = false; ask($('askIn').value); });
  $('chips').addEventListener('click', function (e) { var b = e.target.closest('[data-say]'); if (b) ask(b.dataset.say); });
  $('stop').onclick = function () { aborted = true; busy = false; steps = 0; hush(); stopListening(true); setState('idle', 'Ready'); render(); };
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
  function afterSpeech(fromReply) { speaking = false; quietUntil = Date.now() + 1800; if (busy) return; setState('idle', chat.approvals && chat.approvals.length ? 'Waiting for your OK' : 'Ready'); if (fromReply && $('convo').checked && canRecord) setTimeout(function () { if (!busy && !speaking) startListening(true); }, 250); }
  function speak(text, fromReply) {
    if (!$('speak').checked || !text) { afterSpeech(fromReply); return; }
    hush(); wakeStop(); lastSaid = String(text); quietUntil = Date.now() + 600000; speaking = true; setState('speaking', 'Speaking');
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
  $('testVoice').onclick = function () { unlockAudio(); var was = $('speak').checked; $('speak').checked = true; speak('G’day Will, I’m Eltra. This is how I’ll sound when I read out your brief.'); $('speak').checked = was; };
  try { speechSynthesis.addEventListener('voiceschanged', fillVoices); } catch (e) {}

  // ================= voice in: record, stop on silence, transcribe =================
  var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  var stream = null, recorder = null, chunks = [], listening = false, vad = null, ac = null, cancelRec = false, forceSend = false;
  function mimeType() { var t = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']; for (var i = 0; i < t.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t[i])) return t[i]; return ''; }
  function stopListening(cancel, manual) { cancelRec = !!cancel; forceSend = !!manual; if (recorder && recorder.state !== 'inactive') recorder.stop(); }
  var followUp = false, noSpeech = false;
  function startListening(isFollowUp) {
    if (listening || busy) return;
    followUp = isFollowUp === true;
    wakeStop();
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
        if (noSpeech && !followUp) { noSpeech = false; setState('idle', 'Didn’t hear anything'); $('vHint').textContent = 'I didn’t hear anything. Tap the mic and try again, a little closer.'; return; }
        noSpeech = false;
        if (cancelRec || !(heard || forceSend) || blob.size < 1500) { setState('idle', 'Ready'); return; }
        setState('thinking', 'Transcribing');
        api('listen', { method: 'POST', body: blob }).then(function (d) {
          if (d.text && d.text.trim().length > 1) { wakeHint(); ask(d.text); } else { setState('idle', 'Didn’t catch that'); $('vHint').textContent = 'I couldn’t make that out. Tap the mic and try again.'; }
        }).catch(function (e) { setState('idle', 'Ready'); lastError = 'Couldn’t hear that: ' + e.message; render(); });
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
        if (now - startAt < 300) { floor = Math.min(0.04, Math.max(floor, rms * 1.6)); if (rms > 0.06) heard = true; return; }
        if (rms > Math.max(0.018, floor)) { heard = true; quietSince = 0; }
        else if (heard) { if (!quietSince) quietSince = now; if (now - quietSince > 1400) stopListening(false); }
        if (!heard && now - startAt > (followUp ? 6000 : 8000)) { noSpeech = true; stopListening(true); }
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
        rec.onend = function () { listening = false; if (busy) return; setState('idle', 'Ready'); if (text.trim()) ask(text); };
        rec.start(); listening = true; setState('listening', 'Listening'); return;
      } catch (e) { SR = null; }
    }
    $('askIn').value = ''; $('askIn').focus(); armed = true; setState('listening', 'Dictate now');
    $('vHint').textContent = 'Use the mic key on your keyboard. It sends when you stop.';
  }
  $('askIn').addEventListener('input', function () { clearTimeout(quiet); if (!armed || busy) return; quiet = setTimeout(function () { if (armed && $('askIn').value.trim()) { armed = false; ask($('askIn').value); } }, 2200); });
  $('askIn').addEventListener('keydown', function (e) { if (e.key !== 'Enter' && e.key !== 'Unidentified') armed = false; });
  $('askIn').addEventListener('blur', function () { clearTimeout(quiet); armed = false; if (!busy && orb.dataset.state === 'listening' && !listening) setState('idle', 'Ready'); });
  orb.onclick = function () { unlockAudio(); if (busy) return; if (speaking) { hush(); setState('idle', 'Ready'); return; } if (listening) { stopListening(false, true); return; } startListening(false); };
  document.addEventListener('keydown', function (e) { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); orb.click(); } });

  // ================= wake word: say "Eltra" =================
  // Uses the browser's own speech recognition to listen for the name while the page is open (Chrome, Edge, Safari).
  // "Eltra, brief me" asks straight away; "Eltra" on its own starts normal listening for the question.
  var WSR = window.SpeechRecognition || window.webkitSpeechRecognition, wakeRec = null, wakeOn = !!vs.wake && !!WSR, asleep = false;
  // "Eltra Energy" (the company) never counts as her name
  var WAKE = /\b(eltra|el tra|elltra|eltrah|elta|electra|ultra|altra)\b(?![\s,]*energy)[\s,.!?]*/i;
  var quietUntil = 0, lastSaid = '';
  // ignore anything that is just an echo of what she said in the last few seconds
  function echoOfHer(t) {
    if (Date.now() - quietUntil > 6000 || !lastSaid) return false;
    var norm = function (x) { return String(x).toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(); };
    var heard = norm(t), hers = norm(lastSaid);
    return heard.length > 3 && hers.indexOf(heard) >= 0;
  }
  function wakeStop() { if (wakeRec) { var r = wakeRec; wakeRec = null; try { r.onend = null; r.onresult = null; r.abort(); } catch (e) {} } }
  function wakeStart() {
    if (!(wakeOn || asleep) || wakeRec || busy || speaking || listening || document.hidden || Date.now() < quietUntil) return;
    var r, fired = false;
    try { r = new WSR(); } catch (e) { return; }
    r.lang = 'en-AU'; r.continuous = true; r.interimResults = true;
    r.onresult = function (e) {
      if (fired) return;
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var t = e.results[i][0].transcript, m = t.match(WAKE);
        if (!m || echoOfHer(t)) continue;
        var rest = t.slice(m.index + m[0].length).trim();
        if (asleep) { if (!e.results[i].isFinal) continue; fired = true; wakeStop(); wakeUp(t); return; }
        if (!e.results[i].isFinal) { setState('listening', 'Yes?'); continue; }
        fired = true; wakeStop();
        if (SLEEP_RE.test(rest)) { goSleep(); return; }
        if (rest.length > 2) ask(rest); else { setState('listening', 'Yes?'); setTimeout(startListening, 120); }
        return;
      }
    };
    r.onerror = function (e) {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { wakeOn = false; vs.wake = false; save('eltra-hud-voice', vs); $('wake').checked = false; $('vHint').textContent = 'Allow microphone access to use “Eltra”.'; }
    };
    r.onend = function () { if (wakeRec === r) wakeRec = null; if (!fired && orb.dataset.state === 'listening' && !listening && !busy) setState('idle', 'Ready'); };
    try { r.start(); wakeRec = r; } catch (e) { wakeRec = null; }
  }
  function wakeHint() { $('vHint').textContent = wakeOn ? 'Say “Eltra” and your question, or tap the mic.' : 'Tap and talk. It sends when you stop.'; }
  if (!WSR) { $('wakeRow').hidden = true; }
  $('wake').checked = wakeOn;
  $('wake').onchange = function () { wakeOn = $('wake').checked && !!WSR; vs.wake = wakeOn; save('eltra-hud-voice', vs); if (!wakeOn) wakeStop(); else { unlockAudio(); wakeStart(); } wakeHint(); };
  wakeHint();
  setInterval(function () { if (wakeOn || asleep) wakeStart(); else wakeStop(); }, 1200);
  document.addEventListener('visibilitychange', function () { if (document.hidden) wakeStop(); });

  // ================= sleep mode and the wake-up call =================
  // "Sleep" (or "Eltra, go to sleep") dims the dashboard to a clock and keeps listening for her name.
  // "Hey Eltra, I'm home" plays a short call animation, then she greets you and gives a quick rundown.
  var SLEEP_RE = /^(go to sleep|go to bed|sleep|sleep mode|goodnight|good night|nighty night|that'?s all( for (now|today))?|bye|goodbye|see you|see ya|talk later)[\s.!]*$/i;
  var wakeLock = null, sleepClock = null, actx = null;
  function keepAwake() { try { if (navigator.wakeLock && !wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; l.addEventListener('release', function () { wakeLock = null; }); }).catch(function () {}); } catch (e) {} }
  function letSleep() { try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null; }
  function sleepTick() {
    var n = new Date();
    $('sClock').textContent = fmt(n, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    $('sDate').textContent = fmt(n, { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function goSleep() {
    if (asleep) return;
    unlockAudio(); audioCtx(); hush(); wakeStop();
    asleep = true; $('sleepView').hidden = false; document.body.style.overflow = 'hidden';
    $('sHint').textContent = WSR ? 'Say “Hey Eltra” to wake me' : 'Tap below to wake me (voice wake-up needs Chrome, Edge or Safari)';
    sleepTick(); clearInterval(sleepClock); sleepClock = setInterval(sleepTick, 10000);
    keepAwake(); setState('idle', 'Asleep');
  }
  function audioCtx() { try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { actx = null; } return actx; }
  function chime(freqs, at, len) {
    var c = audioCtx(); if (!c) return;
    freqs.forEach(function (f, i) {
      var o = c.createOscillator(), g = c.createGain(), t = c.currentTime + at + i * 0.16;
      o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + len + 0.05);
    });
  }
  function systemsLine() {
    var st = (D && D.status) || {}, g = st.google || {}, down = [];
    if (g.setUp && !g.connected) down.push('Google');
    if (st.ghl === false) down.push('GoHighLevel');
    if (st.sm8 === false) down.push('ServiceM8');
    if (!D) return 'Systems are still coming online.';
    return down.length ? 'All systems are up, except ' + down.join(' and ') + '.' : 'All systems are up.';
  }
  function greeting(said) {
    var n = new Date(), h = +n.toLocaleString('en-AU', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
    var t = String(said || '').toLowerCase();
    var tod = h < 5 ? 'evening' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
    var first = /\b(i'?m|im|i am) (home|back)\b|\bhome\b/.test(t) ? 'Welcome home, sir. Good ' + tod + '.'
      : /\b(hello|hi|hey)\b/.test(t) && Math.random() < 0.5 ? 'Hello, sir. Good ' + tod + '.'
      : 'Good ' + tod + ', sir.';
    var bits = [], reply = parseInt($('sReply').textContent, 10);
    if (reply > 0) bits.push(reply === 1 ? 'one email needs a reply' : reply + ' emails need replies');
    var now = Date.now(), nx = events.filter(function (e) { return !e.allDay && e.start.getTime() > now; })[0];
    if (nx) {
      var sameDay = fmt(nx.start, { day: 'numeric', month: 'numeric' }) === fmt(n, { day: 'numeric', month: 'numeric' });
      var tmr = fmt(nx.start, { day: 'numeric', month: 'numeric' }) === fmt(new Date(now + 86400000), { day: 'numeric', month: 'numeric' });
      bits.push('next up is ' + (nx.title || 'an appointment') + ' at ' + fmt(nx.start, { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }).replace(/\s/g, '').toLowerCase() + (sameDay ? '' : tmr ? ' tomorrow' : ' on ' + fmt(nx.start, { weekday: 'long' })));
    }
    var line = bits.length ? ' ' + bits.join(', and ').replace(/^./, function (c) { return c.toUpperCase(); }) + '.' : ' All quiet for now.';
    return first + ' ' + systemsLine() + line + ' What can I do for you?';
  }
  // Wake-up: the logo's three bars charge up, then a glowing orb pulses while she talks and drops into the mic button.
  var ampTimer = null;
  function orbPulse(on) {
    var el = $('pOrb'); clearInterval(ampTimer);
    if (!on) { el.style.setProperty('--amp', 1); return; }
    var a = 1;
    ampTimer = setInterval(function () {
      var target = speaking ? 1 + Math.random() * 0.24 : busy ? 1 + 0.05 * Math.sin(Date.now() / 220) : 1 + 0.03 * Math.sin(Date.now() / 600);
      a += (target - a) * 0.45; el.style.setProperty('--amp', a.toFixed(3));
    }, 90);
  }
  function orbToMic() {
    var pv = $('powerView'), el = $('pOrb'), r = orb.getBoundingClientRect(), o = el.getBoundingClientRect();
    orbPulse(false);
    if (r.width && r.top > 0 && r.bottom < innerHeight) {
      var dx = (r.left + r.width / 2) - (o.left + o.width / 2), dy = (r.top + r.height / 2) - (o.top + o.height / 2);
      el.style.transition = 'transform .7s cubic-bezier(.5,0,.2,1), opacity .35s ease .45s';
      el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + (r.width / o.width).toFixed(3) + ')';
    }
    pv.classList.add('done');
    setTimeout(function () { pv.hidden = true; pv.className = 'power'; el.removeAttribute('style'); pv.querySelectorAll('.bar').forEach(function (b) { b.classList.remove('on'); }); }, 800);
  }
  function wakeUp(said) {
    if (!asleep) return;
    asleep = false; clearInterval(sleepClock); letSleep();
    var pv = $('powerView'), bars = pv.querySelectorAll('.bar'), calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    pv.className = 'power'; pv.hidden = false; $('pState').textContent = '';
    $('sleepView').hidden = true; document.body.style.overflow = '';
    loadToday();
    // whatever came after the greeting ("hey Eltra, I'm home, what's on tomorrow?") becomes the first question
    var rest = String(said || '').replace(/^.*?\b(eltra|el tra|elltra|eltrah|elta|electra|ultra|altra)\b[\s,.!?]*/i, '')
      .replace(/^(i'?m|im|i am) (home|back)[\s,.!?]*/i, '').replace(/^(wake up|you there\??|are you there\??|hello|hi|hey)[\s,.!?]*/i, '').trim();
    var notes = [523.25, 659.25, 783.99], gap = calm ? 0 : 320;
    [0, 1, 2].forEach(function (k) { setTimeout(function () { bars[k].classList.add('on'); chime([notes[k]], 0, 0.45); }, 200 + k * gap); });
    setTimeout(function () { pv.classList.add('lit'); }, 200 + 3 * gap);
    setTimeout(function () {
      pv.classList.add('talk'); orbPulse(!calm);
      if (rest.split(' ').length >= 3) { $('pState').textContent = 'On it…'; ask(rest); } else speak(greeting(said), true);
      var t0 = Date.now(), started = false, iv = setInterval(function () {
        if (speaking || busy) started = true;
        var finished = started ? !speaking && !busy : Date.now() - t0 > 1500;
        if (finished || Date.now() - t0 > 25000) { clearInterval(iv); orbToMic(); }
      }, 150);
    }, calm ? 700 : 1650);
  }
  $('sleepBtn').onclick = goSleep;
  $('wakeBtn').onclick = function () { wakeUp('wake up'); };
  document.addEventListener('visibilitychange', function () { if (!document.hidden && asleep) keepAwake(); });

  // ================= drawers: chat and settings stay out of the way until needed =================
  function openDrawer(which) {
    var c = $('chatDrawer'), st = $('setDrawer');
    c.hidden = which !== 'chat'; st.hidden = which !== 'settings'; $('scrim').hidden = false;
    if (which === 'chat') { $('chatBtn').classList.remove('has'); var lg = $('log'); lg.scrollTop = lg.scrollHeight; }
  }
  function closeDrawers() { $('chatDrawer').hidden = true; $('setDrawer').hidden = true; $('scrim').hidden = true; }
  $('chatBtn').onclick = function () { if ($('chatDrawer').hidden) openDrawer('chat'); else closeDrawers(); };
  $('gearBtn').onclick = function () { openDrawer('settings'); };
  $('sysPill').onclick = function () { openDrawer('settings'); };
  $('scrim').onclick = closeDrawers;
  document.querySelectorAll('[data-close]').forEach(function (b) { b.onclick = closeDrawers; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawers(); });

  // ================= start =================
  function startApp() {
    tick(); setInterval(tick, 1000); setInterval(renderNext, 30000);
    render(); loadToday();
    api('speak').then(function (d) { voices = d; fillVoices(); }).catch(function () { voices = { configured: false }; fillVoices(); });
    if (/google=connected/.test(location.search)) history.replaceState(null, '', '/');
  }
  api('login').then(function (d) { if (d.loggedIn) showApp(); else showLogin(); }).catch(showLogin);
})();
