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

  // ================= collapsible sections =================
  // which panels and to-do section headers are folded away, remembered on this device: { 'panel:calH': true, 'todo:DNSP': true, … }
  var SHUT = load('eltra-collapsed', {}) || {};
  function isShut(k) { return !!SHUT[k]; }
  function setShut(k, v) { if (v) SHUT[k] = true; else delete SHUT[k]; save('eltra-collapsed', SHUT); }
  // every dashboard panel with a heading gets a click-to-collapse arrow and a count (the improvement ideas panel already has its own)
  document.querySelectorAll('section.hud > .hh > h2').forEach(function (h) {
    var sec = h.parentNode.parentNode, key = 'panel:' + h.id;
    if (sec.id === 'impPanel') return;
    var b = document.createElement('button'); b.type = 'button'; b.className = 'imptog ptog';
    b.innerHTML = '<span class="car" aria-hidden="true">▸</span><span class="impt"></span> <span class="impn" data-pcount></span>';
    b.querySelector('.impt').textContent = h.textContent;
    h.textContent = ''; h.appendChild(b);
    var show = function () { var s = isShut(key); sec.classList.toggle('shut', s); b.setAttribute('aria-expanded', s ? 'false' : 'true'); b.title = s ? 'Show' : 'Hide'; };
    b.onclick = function () { setShut(key, !isShut(key)); show(); };
    show();
  });
  // the item count on a panel's header (stays visible when it's collapsed)
  function panelCount(hid, n) { var c = $(hid) && $(hid).querySelector('[data-pcount]'); if (c) c.textContent = n == null ? '' : n; }

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
  var me = { user: 'will', name: 'Will' };
  var isEthan = function () { return me.user === 'ethan'; };
  function showApp() { $('loginView').hidden = true; $('appView').hidden = false; if (!started) { started = true; startApp(); } }
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault(); $('loginErr').textContent = '';
    // reload after logging in, so nothing from a previous person's session stays on screen
    api('login', { method: 'POST', body: { password: $('pw').value } }).then(function () { $('pw').value = ''; location.reload(); }).catch(function (err) { $('loginErr').textContent = err.message; });
  });
  $('logout').onclick = function () {
    try { if (localStorage.getItem('eltra-keep-chat') !== '1') localStorage.removeItem(CHAT); } catch (e) {}
    api('login', { method: 'DELETE' }).catch(function () {}).then(function () { location.reload(); });
  };

  // ================= clock =================
  function tick() {
    var n = new Date(), h = +n.toLocaleString('en-AU', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
    $('clock').textContent = fmt(n, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    $('today').textContent = fmt(n, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' · Melbourne';
    $('greet').textContent = (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + ', ' + me.name + '.';
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
    if (nx.sale) b.push('<button type="button" class="prep" id="prepVisit">Prep this visit</button>');
    $('nextMeta').innerHTML = b.join('');
    nextEv = nx;
  }
  var nextEv = null;
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
    var ig = s.instagram || {};
    var igDot = !ig.setUp ? '' : ig.connected ? '<span><i class="dot on"></i>Instagram' + (ig.username ? ' @' + esc(ig.username) : '') + '</span>' : '<span><i class="dot warn"></i><a href="/.netlify/functions/instagram-auth?start=1">Connect Instagram</a></span>';
    $('sys').innerHTML = googleDot + dot(s.ghl, 'GoHighLevel') + dot(s.sm8, 'ServiceM8') + igDot + dot(s.voice, 'Voice');
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
        h += '<div class="ev' + (past ? ' past' : '') + (live ? ' now' : e.sale ? ' sale' : '') + '"><time>' + (e.allDay ? 'All day' : esc(fmt(e.start, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))) + (!e.allDay && e.end ? '<small>' + Math.round((e.end - e.start) / 60000) + ' min</small>' : '') + '</time><div><div class="t"><a href="' + esc(e.link) + '" target="_blank" rel="noopener">' + esc(e.title) + '</a>' + (e.sale ? '<span class="tag sale">Sales</span>' : '') + (e.sale && !past ? '<button type="button" class="evprep" data-prepev="' + events.indexOf(e) + '">Prep</button>' : '') + '</div>' + (d.length ? '<div class="d">' + d.join('') + '</div>' : '') + '</div></div>';
      });
      return h + '</div>';
    });
    if (D.calendar) $('calStamp').textContent = D.calendar.error ? 'Sync failed' : stamp;
    panelCount('calH', g.connected && D.calendar && !D.calendar.error ? events.length : null);
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
    panelCount('mailH', g.connected && D.mail && !D.mail.error ? mail.length : null);

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
    panelCount('leadH', s.ghl && D.leads && !D.leads.error ? D.leads.data.length : null);
    panelCount('jobH', s.sm8 && D.jobs && !D.jobs.error ? D.jobs.data.length : null);
    if (!s.sm8) $('jobs').innerHTML = '<p class="note">Not connected yet. Add SERVICEM8_API_KEY in Netlify to connect ServiceM8.</p>';
    else section(D.jobs, 'jobs', 'Nothing booked in the next 7 days.', function (list) {
      return '<ul class="list">' + list.map(function (j) { var job = j.job || {}, m = String(j.start || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/), when = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
        return '<li><button type="button" class="row" data-say="Tell me about ServiceM8 job ' + esc(job.job_no ? '#' + job.job_no : job.uuid) + ' at ' + esc(job.address || '') + '."><div class="r1"><span class="who">' + esc([job.job_no && '#' + job.job_no, job.status, j.staff].filter(Boolean).join(' · ')) + '</span><span class="dt">' + (when ? esc(when.toLocaleString('en-AU', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })) : '') + '</span></div><div class="s">' + esc(job.address || 'Job') + '</div>' + (job.description ? '<div class="sn">' + esc(job.description) + '</div>' : '') + '</button></li>'; }).join('') + '</ul>';
    });
  }
  var todayTimer = null;
  function loadToday() {
    clearTimeout(todayTimer); todayTimer = setTimeout(loadToday, 3 * 60000);
    loadTodos(); loadContent(); loadImprove();
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
  var LABELS = { gmail_search: 'Searching email', gmail_read: 'Reading email', gmail_create_draft: 'Drafting email', gmail_send_draft: 'Sending email', gmail_send: 'Sending email', gmail_archive: 'Archiving email', gmail_save_attachments: 'Saving attachments', calendar_events: 'Checking calendar', calendar_create_event: 'Adding to calendar', calendar_update_event: 'Updating calendar', calendar_delete_event: 'Removing from calendar', drive_search: 'Searching Drive', sheets_read: 'Reading sheet', pylon_find_projects: 'Checking Pylon', pylon_project: 'Opening Pylon project', pylon_create_project: 'Setting up Pylon project', pylon_new_project_link: 'Making Pylon link', drive_read_file: 'Reading file', todo_list: 'Checking to-dos', todo_add: 'Adding to-do', todo_update: 'Updating to-do', dnsp_task_pack: 'Preparing the DNSP task', read_document: 'Reading document', instagram_skill: 'Loading Instagram guide', instagram_humanize: 'Polishing the post', instagram_voice: 'Checking our Instagram voice', instagram_hooks: 'Scoring hooks', instagram_beats: 'Timing the script', instagram_swipe: 'Ranking what works', instagram_carousel: 'Making carousel slides', brand_wallpaper: 'Making wallpaper', instagram_post: 'Posting to Instagram', instagram_finish_post: 'Finishing the post', instagram_insights: 'Checking Instagram numbers', instagram_comments: 'Reading comments', instagram_reply: 'Replying on Instagram', instagram_hide_comment: 'Hiding comment', instagram_research: 'Researching accounts', instagram_research_in_browser: 'Preparing the research task', content_schedule: 'Checking the schedule', content_edit: 'Updating the schedule', suggest_improvement: 'Noting an improvement', jobs_list: 'Checking jobs', learn_rule: 'Learning a rule', learned_rules: 'Checking what I’ve learned', unlearn_rule: 'Forgetting a rule', job_install_date: 'Saving the install date', install_date_check: 'Looking up the customer', install_check_send_email: 'Emailing the customer', install_check_send_sms: 'Texting the customer', install_check_update: 'Updating the install check', drive_list_folder: 'Opening folder', drive_move: 'Moving files', drive_create_folder: 'Creating folder', drive_rename: 'Renaming', ghl_pipelines: 'Checking pipeline', ghl_search_opportunities: 'Looking up leads', ghl_search_contacts: 'Looking up contacts', ghl_move_opportunity: 'Updating lead', ghl_add_note: 'Adding note', ghl_add_task: 'Adding task', sm8_jobs: 'Looking up jobs', sm8_schedule: 'Checking schedule', sm8_add_job_note: 'Adding job note', sm8_create_job: 'Creating job' };
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
  // Eltra's own bookkeeping notes about searches (kept for her, not shown or read out)
  function isNote(t) { return /^\[(Searched the web|Search results used|Sources cited)/.test(String(t || '').trim()); }
  var taskCards = [], carousels = [], wallpapers = [];
  // wallpaper sizes the brand_wallpaper tool can ask for (drawn by drawWallpaper below)
  var WP_SIZES = {
    phone: { w: 1170, h: 2532, label: 'iPhone' }, phone_1080: { w: 1080, h: 1920, label: 'Phone' },
    desktop: { w: 1920, h: 1080, label: 'Desktop' }, desktop_4k: { w: 3840, h: 2160, label: 'Desktop 4K' }
  };
  function render() {
    var h = ''; taskCards = []; carousels = []; wallpapers = [];
    if (!chat.messages.length) h = '<div class="empty">Ask about your day, your email, a customer or a job</div>';
    chat.messages.forEach(function (m, mi) {
      if (m.role === 'user') {
        var lastTxt = Array.isArray(m.content) && m.content.length ? m.content[m.content.length - 1].text : null, th = (chat.thumbs && lastTxt && chat.thumbs[lastTxt]) || [], thi = 0;
        if (typeof m.content === 'string') { h += '<div class="m you">' + esc(m.content) + '</div>'; return; }
        var shown = (m.content || []).filter(function (c) { return c.type === 'image' || c.type === 'document' || (c.type === 'text' && c.text); });
        if (shown.length && !(m.content || []).some(function (c) { return c.type === 'tool_result'; })) {
          var pics = '', words = '';
          shown.forEach(function (c) {
            if (c.type === 'image') { pics += '<img class="att" alt="Photo you sent" src="data:' + esc(c.source.media_type) + ';base64,' + c.source.data + '">'; thi++; }
            else if (c.type === 'document') pics += '<span class="attdoc">PDF</span>';
            else if (/^\[Attached photo/.test(c.text) && th[thi]) pics += '<img class="att" alt="Photo you sent" src="' + th[thi++] + '">';
            else if (/^\[Attached /.test(c.text)) pics += '<span class="attdoc">' + esc(c.text.replace(/^\[Attached (\w+).*$/, '$1')) + '</span>';
            else if (/^\[Photos? saved for posting/.test(c.text)) { /* link for Eltra, not shown */ }
            else words += esc(c.text);
          });
          h += '<div class="m you">' + (pics ? '<div class="atts">' + pics + '</div>' : '') + words + '</div>'; return;
        }
        (m.content || []).forEach(function (c) {
          if (c.type === 'tool_result' && typeof c.content === 'string' && c.content.indexOf('"carousel"') >= 0) {
            var cs; try { cs = JSON.parse(c.content).carousel; } catch (e) { cs = null; }
            if (cs && cs.slides && cs.slides.length) {
              var ck = carousels.push(cs) - 1;
              h += '<div class="card task"><div class="ch">Carousel · ' + cs.slides.length + ' slides</div><div class="slides">' + cs.slides.map(function (sl, si) { return '<canvas class="slide" width="216" height="270" data-car="' + ck + '" data-slide="' + si + '" aria-label="Slide ' + (si + 1) + ': ' + esc(sl.heading) + '"></canvas>'; }).join('') + '</div><div class="row"><button type="button" class="btn" data-cardl="' + ck + '">Save slide images</button>' + (igConnected() ? '<button type="button" class="btn no" data-carpost="' + ck + '">Post to Instagram</button>' : '') + '</div></div>';
            }
            return;
          }
          if (c.type === 'tool_result' && typeof c.content === 'string' && c.content.indexOf('"wallpaper"') >= 0) {
            var wp; try { wp = JSON.parse(c.content).wallpaper; } catch (e) { wp = null; }
            if (wp && wp.sizes) wp.sizes = wp.sizes.filter(function (k) { return WP_SIZES[k]; });
            if (wp && wp.sizes && wp.sizes.length) {
              var wk = wallpapers.push(wp) - 1;
              h += '<div class="card task"><div class="ch">Wallpaper' + (wp.tagline ? ' · ' + esc(wp.tagline) : '') + '</div><div class="slides">' + wp.sizes.map(function (k) { var z = WP_SIZES[k], sc = 270 / Math.max(z.w, z.h); return '<canvas class="wp" width="' + Math.round(z.w * sc) + '" height="' + Math.round(z.h * sc) + '" data-wp="' + wk + '" data-wpsize="' + k + '" aria-label="' + esc(z.label) + ' wallpaper preview"></canvas>'; }).join('') + '</div><div class="row">' + wp.sizes.map(function (k) { var z = WP_SIZES[k]; return '<button type="button" class="btn" data-wpdl="' + wk + '" data-wpsize="' + k + '">Save ' + esc(z.label) + ' ' + z.w + '×' + z.h + '</button>'; }).join('') + '</div></div>';
              return;
            }
          }
          if (c.type !== 'tool_result' || typeof c.content !== 'string' || c.content.indexOf('"browser_task"') < 0) return;
          var bt; try { bt = JSON.parse(c.content).browser_task; } catch (e) { return; }
          if (!bt) return;
          var key = 'bt' + (taskCards.push(bt) - 1);
          h += '<div class="card task"><div class="ch">For Claude in Chrome</div><div><b>' + esc(bt.title) + '</b>' + (bt.distributor ? ' · ' + esc(bt.distributor) : '') + '</div>' +
            (bt.missing && bt.missing.length ? '<div class="miss">Still needed: ' + bt.missing.map(esc).join(', ') + '</div>' : '<div class="miss ok">Everything the pack needs is filled in.</div>') +
            '<details><summary>Show the instruction</summary><pre>' + esc(bt.instruction) + '</pre></details>' +
            '<div class="row"><button type="button" class="btn" data-taskcopy="' + key + '">Copy for Claude in Chrome</button>' +
            (bt.portal_url ? '<a class="btn no" href="' + esc(bt.portal_url) + '" target="_blank" rel="noopener">Open ' + esc(bt.distributor || 'portal') + ' portal</a>' : '<button type="button" class="btn no" data-portals>Add ' + esc(bt.distributor || 'portal') + ' link</button>') + '</div></div>';
        });
        return;
      }
      var said = (m.content || []).filter(function (c) { return c.type === 'text' && c.text.trim() && !isNote(c.text); }).length;
      (m.content || []).forEach(function (c) {
        if (c.type === 'text' && c.text.trim() && !isNote(c.text)) h += '<div class="m ai">' + md(c.text) + '</div>';
        else if (c.type === 'tool_use') {
          var r = chat.results[c.id];
          if (r) h += '<div class="card done"><div class="ch">' + esc(r.title) + '</div><div class="res ' + (r.ok ? 'ok' : 'no') + '">' + (r.ok ? '✓ Approved' : '✕ Cancelled') + '</div></div>';
          else if (!(chat.approvals || []).some(function (a) { return a.id === c.id; })) h += '<div class="act">' + esc(LABELS[c.name] || c.name) + ((c.name === 'gmail_create_draft' || c.name === 'gmail_send') && c.input ? (c.input.emails && c.input.emails.length ? ' · ' + c.input.emails.length + ' emails' : c.input.to ? ' · to ' + esc(c.input.to) : '') : '') + '</div>';
        }
      });
      if (said && !(chat.feedback || {})[mi]) h += '<div class="fbrow"><button type="button" class="fb" data-fb="' + mi + '" aria-label="Not a good reply" title="Not a good reply">👎</button></div>';
      else if (said) h += '<div class="fbrow"><span class="fbdone">Noted, thanks</span></div>';
    });
    (chat.approvals || []).forEach(function (a) {
      h += '<div class="card"><div class="ch">Needs your OK</div><div><b>' + esc(a.title) + '</b></div>' + (a.lines || []).map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('') + (a.preview ? '<pre>' + esc(a.preview) + '</pre>' : '') +
        '<div class="row"><button type="button" class="btn go" data-ok="' + esc(a.id) + '">Approve</button><button type="button" class="btn no" data-no="' + esc(a.id) + '">Cancel</button></div></div>';
    });
    if (busy) h += '<div class="act wait">Working…</div>';
    if (lastError) h += '<div class="m err"><span>' + esc(lastError) + '</span><button type="button" class="copy" id="retry">Try again</button></div>';
    $('log').innerHTML = h; $('log').scrollTop = $('log').scrollHeight;
    var drawThumbs = function () { document.querySelectorAll('#log canvas.slide').forEach(function (cv) { drawSlide(cv, carousels[+cv.dataset.car], +cv.dataset.slide, 0.2); });
      document.querySelectorAll('#log canvas.wp').forEach(function (cv) { var z = WP_SIZES[cv.dataset.wpsize]; drawWallpaper(cv, wallpapers[+cv.dataset.wp], cv.dataset.wpsize, cv.width / z.w); }); };
    drawThumbs(); if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawThumbs);
    var r = $('retry'); if (r) r.onclick = function () { lastError = null; step({}); };
    $('sendBtn').disabled = busy; $('stop').hidden = !busy;
  }
  $('log').addEventListener('click', function (e) {
    var fb = e.target.closest('[data-fb]');
    if (fb) {
      var mi = +fb.dataset.fb, m = chat.messages[mi], asked = '';
      for (var q = mi - 1; q >= 0; q--) { var u = chat.messages[q]; if (u.role === 'user') { var t = typeof u.content === 'string' ? u.content : (u.content || []).filter(function (c) { return c.type === 'text' && !/^\[/.test(c.text); }).map(function (c) { return c.text; }).join(' '); if (t) { asked = t; break; } } }
      var reply = (m.content || []).filter(function (c) { return c.type === 'text' && !isNote(c.text); }).map(function (c) { return c.text; }).join(' ');
      var note = prompt('What was wrong with that reply? (optional)');
      if (note === null) return;
      api('improve', { method: 'POST', body: { action: 'feedback', asked: asked, reply: reply, note: note } }).then(function () { chat.feedback = chat.feedback || {}; chat.feedback[mi] = 1; persist(); render(); }).catch(function () {});
      return;
    }
    var dl = e.target.closest('[data-cardl]'); if (dl) { saveCarousel(carousels[+dl.dataset.cardl], dl); return; }
    var wdl = e.target.closest('[data-wpdl]'); if (wdl) { saveWallpaper(wallpapers[+wdl.dataset.wpdl], wdl.dataset.wpsize, wdl); return; }
    var cpb = e.target.closest('[data-carpost]'); if (cpb) { postCarousel(carousels[+cpb.dataset.carpost], cpb); return; }
    var cp = e.target.closest('[data-taskcopy]');
    if (cp) {
      e.stopPropagation();
      var bt = taskCards[+cp.dataset.taskcopy.slice(2)]; if (!bt) return;
      var done = function () { var old = cp.textContent; cp.textContent = 'Copied ✓'; setTimeout(function () { cp.textContent = old; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(bt.instruction).then(done, function () { fallbackCopy(bt.instruction); done(); }); else { fallbackCopy(bt.instruction); done(); }
      return;
    }
    if (e.target.closest('[data-portals]')) { openDrawer('settings'); setTimeout(function () { var f = document.querySelector('#portalList input'); if (f) f.focus(); }, 400); return; }
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
    var fw0 = findWake(text); if (SLEEP_RE.test((fw0 ? String(text).slice(fw0.end) : String(text)).trim())) { goSleep(); return; }
    text = String(text || '').trim(); if ((!text && !pendingAtt.length) || busy) return;
    if (pendingAtt.some(function (p) { return p.loading; })) { $('vHint').textContent = 'Still preparing your photo, one moment…'; return; }
    unlockAudio(); hush();
    $('askIn').value = '';
    if (chat.approvals && chat.approvals.length) {
      // Spoken or typed approval: a short "approve", "yes, send it", "go ahead"… approves everything waiting;
      // "cancel", "no"… cancels it. Anything longer cancels and is treated as a new request, as before.
      var said = pendingAtt.length ? null : voiceAnswer(text);
      if (said !== null) { decideAll(said); if (!said) speak('Cancelled.'); return; }
      var d = {}; chat.approvals.forEach(function (a) { d[a.id] = false; chat.results[a.id] = { title: a.title, ok: false }; }); chat.approvals = null; chat.pending = text; persist(); step(d); return;
    }
    if (pendingAtt.length) {
      var blocks = pendingAtt.map(function (p) { return p.block; });
      var links = pendingAtt.filter(function (p) { return p.url; }).map(function (p) { return p.url; });
      if (links.length) blocks.push({ type: 'text', text: '[Photo' + (links.length > 1 ? 's' : '') + ' saved for posting to Instagram: ' + links.join(' ') + ']' });
      blocks.push({ type: 'text', text: text || (pendingAtt.length > 1 ? 'Here are some files.' : 'Here’s a file.') });
      var smalls = pendingAtt.map(function (p) { return p.small || ''; });
      chat.messages.push({ role: 'user', content: blocks });
      chat.thumbs = chat.thumbs || {}; chat.thumbs[blocks[blocks.length - 1].text] = smalls;
      pendingAtt = []; renderAtt();
    } else chat.messages.push({ role: 'user', content: text });
    persist(); step({});
  }
  function step(decisions) {
    busy = true; aborted = false; lastError = null; setState('thinking', 'Thinking'); render();
    api('agent', { method: 'POST', body: { messages: chat.messages, decisions: decisions } }).then(function (d) {
      if (aborted) return;
      chat.messages = d.messages || chat.messages;
      if (d.state === 'approval') { chat.approvals = d.approvals; busy = false; steps = 0; persist(); render(); openDrawer('chat'); setState('idle', 'Awaiting OK'); speak('Needs your OK: ' + d.approvals.map(function (a) { return a.title; }).join(', and ') + '. Say approve or cancel.', true); return; }
      if (d.acted && d.acted.length) setTimeout(loadToday, 1500);
      if (d.state === 'continue' && steps++ < 12) { persist(); render(); step({}); return; }
      busy = false; steps = 0; stripAttachments(); persist();
      if (chat.pending) { var t = chat.pending; chat.pending = null; ask(t); return; }
      render();
      var last = chat.messages[chat.messages.length - 1];
      var text = last && last.role === 'assistant' ? (last.content || []).filter(function (c) { return c.type === 'text' && !isNote(c.text); }).map(function (c) { return c.text; }).join(' ') : '';
      var recent = JSON.stringify(chat.messages.slice(-6));
      if (recent.indexOf('todo_') >= 0) loadTodos();
      if (recent.indexOf('content_') >= 0) loadContent();
      if (/suggest_improvement|learn_rule|unlearn_rule/.test(recent)) loadImprove();
      if (text && !$('speak').checked) openDrawer('chat'); else if (text && $('chatDrawer').hidden) $('chatBtn').classList.add('has');
      if (text) speak(text, asksSomething(text)); else setState('idle', 'Ready');
    }).catch(function (e) {
      if (aborted) return;
      if (e.data && e.data.messages) chat.messages = e.data.messages;
      busy = false; steps = 0; lastError = e.message; persist(); render(); setState('idle', 'Ready'); openDrawer('chat');
    });
  }
  $('askForm').addEventListener('submit', function (e) { e.preventDefault(); armed = false; ask($('askIn').value); });
  $('askIn').addEventListener('focus', function () { if (!$('chatDrawer').hidden) return; });
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
  // Say things the way a person would: units, money, symbols. Keeps the voice from tripping over them.
  function sayable(t) {
    return String(t)
      .replace(/\$\s?(\d[\d,]*)(\.\d\d)?\b/g, function (m, d, c) { return d + (c && c !== '.00' ? ' dollars ' + c.slice(1) + ' cents' : ' dollars'); })
      .replace(/(\d)\s?kWh\b/gi, '$1 kilowatt hours').replace(/(\d)\s?kW\b/gi, '$1 kilowatt').replace(/(\d)\s?MWh\b/g, '$1 megawatt hours')
      .replace(/(\d)\s?c\/kWh\b/gi, '$1 cents per kilowatt hour').replace(/(\d)\s?%/g, '$1 percent')
      .replace(/(\d)\s?km\b/gi, '$1 kilometres').replace(/(\d)\s?×\s?/g, '$1 times ')
      .replace(/\bSTCs?\b/g, function (m) { return m === 'STCs' ? 'S T Cs' : 'S T C'; }).replace(/\bGHL\b/g, 'GoHighLevel').replace(/\bSM8\b/g, 'ServiceM8')
      .replace(/\bVIC\b/g, 'Victoria').replace(/\be\.g\./gi, 'for example').replace(/\bi\.e\./gi, 'that is').replace(/&/g, ' and ')
      .replace(/\s[–—-]\s/g, ', ').replace(/[#*_`>|~]/g, '').replace(/\s{2,}/g, ' ').trim();
  }
  // Long passages are where synthetic voices drift and garble: speak the first few sentences, the rest stays on screen.
  function forVoice(t) {
    t = String(t); if (t.length <= 600) return t;
    var cut = t.slice(0, 600), end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    return (end > 200 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '.') + ' The rest is on screen.';
  }
  function clean(t) { return String(t).replace(/\*\*/g, '').replace(/^\s*[-•*]\s+/gm, '').replace(/https?:\/\/\S+/g, 'the link').slice(0, 1800); }
  function afterSpeech(fromReply) { speaking = false; quietUntil = Date.now() + 1800; if (busy) return; setState('idle', chat.approvals && chat.approvals.length ? 'Waiting for your OK' : 'Ready'); if (fromReply && $('convo').checked && canRecord) setTimeout(function () { if (!busy && !speaking) startListening(true); }, 250); }
  // A small notice whenever the voice isn't the chosen ElevenLabs one, so it never changes silently.
  var noticeT = null, toldNoKey = false, speakSeq = 0;
  function voiceNotice(msg) { var t = $('voiceToast'); t.textContent = msg; t.hidden = false; clearTimeout(noticeT); noticeT = setTimeout(function () { t.hidden = true; }, 7000); }
  function speak(text, fromReply) {
    if (!$('speak').checked || !text) { afterSpeech(fromReply); return; }
    hush(); wakeStop(); lastSaid = String(text); quietUntil = Date.now() + 600000; speaking = true; setState('speaking', 'Speaking');
    if (vs.engine === 'device') return deviceSpeak(text, fromReply);
    var my = ++speakSeq, failed = false, live = function () { return speaking && my === speakSeq && !failed; };
    var fallback = function (why) {
      if (!live()) return; failed = true; try { player.pause(); } catch (e) {}
      voiceNotice('Couldn’t use your ElevenLabs voice' + (why ? ' (' + why + ')' : '') + ', so this reply used the browser voice.');
      deviceSpeak(text, fromReply);
    };
    if (voices && !voices.configured) {
      if (!toldNoKey) { toldNoKey = true; voiceNotice('ElevenLabs isn’t set up (no API key in Netlify), so Eltra is using the browser voice.'); }
      return deviceSpeak(text, fromReply);
    }
    api('speak', { method: 'POST', body: { text: forVoice(sayable(clean(text))), voice_id: vs.voice || (voices && voices.default) || '', model: vs.model || '', stability: vs.stability, speed: +$('rate').value || 1 }, raw: true })
      .then(function (res) {
        if (!live()) { try { res.body && res.body.cancel(); } catch (e) {} return; }
        var note = res.headers.get('X-Eltra-Voice-Note'); if (note) { try { voiceNotice(decodeURIComponent(note)); } catch (e) {} }
        return playAudio(res, live, fallback, function () { if (my === speakSeq) afterSpeech(fromReply); });
      })
      .catch(function (e) { fallback(e && e.message); });
  }
  // Play the reply as it streams in (MediaSource), so it starts talking before the whole clip has arrived.
  // Browsers without streaming support (or if it ever fails) wait for the whole clip instead.
  var MSC = window.ManagedMediaSource || window.MediaSource;
  var canStream = !!(MSC && MSC.isTypeSupported && MSC.isTypeSupported('audio/mpeg') && window.ReadableStream) && !load('eltra-no-stream', false);
  function playAudio(res, live, fail, done) {
    if (speakUrl) { try { URL.revokeObjectURL(speakUrl); } catch (e) {} speakUrl = null; }
    player.onended = done; player.onplaying = null;
    if (!canStream || !res.body) {
      return res.blob().then(function (blob) {
        if (!live()) return;
        speakUrl = URL.createObjectURL(blob); player.onerror = function () { fail('couldn’t play the audio'); }; player.src = speakUrl;
        return player.play().catch(function () { fail('couldn’t play the audio'); });
      });
    }
    var ms = new MSC(), reader = res.body.getReader(), queue = [], ended = false, started = false;
    var stopStream = function () { canStream = false; save('eltra-no-stream', true); };
    var bail = function (why, net) { try { reader.cancel(); } catch (e) {} if (!started && !net) stopStream(); fail(why); };
    player.disableRemotePlayback = true;
    player.onplaying = function () { started = true; };
    player.onerror = function () { if (live()) bail('couldn’t play the audio'); };
    ms.addEventListener('sourceopen', function () {
      var sb; try { sb = ms.addSourceBuffer('audio/mpeg'); } catch (e) { bail('couldn’t play the audio'); return; }
      var next = function () {
        if (!live() || sb.updating) return;
        if (queue.length) { try { sb.appendBuffer(queue.shift()); } catch (e) { bail('couldn’t play the audio'); } return; }
        if (ended && ms.readyState === 'open') { try { ms.endOfStream(); } catch (e) {} }
      };
      sb.addEventListener('updateend', next);
      (function pump() {
        reader.read().then(function (r) {
          if (!live()) { try { reader.cancel(); } catch (e) {} return; }
          if (r.done) ended = true; else queue.push(r.value);
          next(); if (!r.done) pump();
        }).catch(function () { if (!live()) return; if (started) { ended = true; next(); } else bail('the audio stream dropped out', true); });
      })();
    }, { once: true });
    speakUrl = URL.createObjectURL(ms); player.src = speakUrl;
    return player.play().catch(function () { if (live()) bail('couldn’t play the audio'); });
  }
  function deviceVoice() { var v = ('speechSynthesis' in window) ? speechSynthesis.getVoices() : []; return v.filter(function (x) { return (x.voiceURI || x.name) === vs.device; })[0] || v.filter(function (x) { return /en-AU/i.test(x.lang); })[0] || v.filter(function (x) { return /^en/i.test(x.lang); })[0] || null; }
  function deviceSpeak(text, fromReply) {
    if (!('speechSynthesis' in window)) { afterSpeech(fromReply); return; }
    var u = new SpeechSynthesisUtterance(clean(text)), v = deviceVoice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-AU';
    u.rate = +$('rate').value || 1; u.onend = u.onerror = function () { afterSpeech(fromReply); };
    speaking = true; setState('speaking', 'Speaking'); speechSynthesis.speak(u);
  }
  function fillVoices() {
    var sel = $('voiceSel'), h = '', on = !!(voices && voices.configured);
    if (on && voices.voices.length) {
      h += '<optgroup label="ElevenLabs">' + voices.voices.map(function (v) { return '<option value="el:' + esc(v.id) + '">' + esc(v.name + [v.accent, v.gender].filter(Boolean).map(function (x) { return ' · ' + x; }).join('')) + '</option>'; }).join('') + '</optgroup>';
    } else if (on && vs.voice) h += '<optgroup label="ElevenLabs"><option value="el:' + esc(vs.voice) + '">' + esc(vs.voiceName || 'Your saved voice') + '</option></optgroup>';
    var dv = ('speechSynthesis' in window) ? speechSynthesis.getVoices().filter(function (v) { return /^en/i.test(v.lang); }) : [];
    if (dv.length) h += '<optgroup label="This device">' + dv.map(function (v) { return '<option value="dv:' + esc(v.voiceURI || v.name) + '">' + esc(v.name + ' · ' + v.lang) + '</option>'; }).join('') + '</optgroup>';
    sel.innerHTML = h || '<option>Device default</option>';
    sel.value = vs.engine === 'device' && vs.device ? 'dv:' + vs.device : 'el:' + (vs.voice || (voices && voices.default) || '');
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
    var models = (voices && voices.models) || [];
    $('modelSel').innerHTML = models.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>'; }).join('');
    if (vs.model) $('modelSel').value = vs.model;
    $('modelRow').hidden = $('stabRow').hidden = !on || vs.engine === 'device';
    $('voiceNote').textContent = on ? (voices.error ? 'ElevenLabs: ' + voices.error : 'Your choice is saved and used on every device. Add voices in your ElevenLabs account and they appear here.') : !voices ? 'Couldn’t load your ElevenLabs voices. Check your connection and reload.' : 'ElevenLabs isn’t set up: add ELEVENLABS_API_KEY in Netlify for your ElevenLabs voices. Using this device’s voice for now.';
  }
  // Voice settings are saved on the server for each person, so every device and every reply uses the same voice.
  var saveT = null;
  function saveVoice() {
    save('eltra-hud-voice', vs); clearTimeout(saveT); $('voiceSaved').textContent = '';
    saveT = setTimeout(function () {
      api('speak', { method: 'POST', body: { save: { engine: vs.engine === 'device' ? 'device' : 'eleven', voice: vs.voice || '', voice_name: vs.voiceName || '', model: vs.model || '', stability: vs.stability, speed: vs.rate || 1 } } })
        .then(function () { $('voiceSaved').textContent = 'Saved'; }).catch(function (e) { $('voiceSaved').textContent = 'Couldn’t save: ' + e.message; });
    }, 600);
  }
  function gotVoices(d) {
    voices = d; var s = d.settings || {};
    if (s.saved) {
      vs.engine = s.engine; if (s.voice) vs.voice = s.voice; if (s.voice_name) vs.voiceName = s.voice_name;
      vs.model = s.model; vs.stability = s.stability; vs.rate = s.speed; save('eltra-hud-voice', vs);
    } else {
      // first time: lock in what this device was using (or the default), so the voice doesn't change from here on
      if (!vs.model) vs.model = s.model; if (vs.stability == null) vs.stability = s.stability;
      if (!vs.voice && d.default) vs.voice = d.default;
      if (d.configured && vs.voice) { vs.voiceName = nameOf(vs.voice) || vs.voiceName; saveVoice(); }
    }
    showVoiceSettings(); fillVoices();
  }
  function nameOf(id) { var v = voices && voices.voices ? voices.voices.filter(function (x) { return x.id === id; })[0] : null; return v ? v.name : ''; }
  function showVoiceSettings() {
    if (vs.rate) $('rate').value = vs.rate; showRate();
    if (vs.stability != null) $('stab').value = vs.stability; showStab();
  }
  $('voiceSel').onchange = function () {
    var v = $('voiceSel').value;
    if (v.indexOf('el:') === 0) { vs.engine = 'eleven'; vs.voice = v.slice(3); vs.voiceName = nameOf(vs.voice) || vs.voiceName; } else { vs.engine = 'device'; vs.device = v.slice(3); }
    $('modelRow').hidden = $('stabRow').hidden = !(voices && voices.configured) || vs.engine === 'device';
    saveVoice();
  };
  $('modelSel').onchange = function () { vs.model = $('modelSel').value; saveVoice(); };
  var showRate = function () { $('rateV').textContent = (+$('rate').value).toFixed(2) + '×'; };
  var showStab = function () { $('stabV').textContent = Math.round(+$('stab').value * 100) + '%'; };
  showVoiceSettings();
  $('rate').oninput = function () { vs.rate = +$('rate').value; showRate(); saveVoice(); };
  $('stab').oninput = function () { vs.stability = +$('stab').value; showStab(); saveVoice(); };
  $('speak').checked = vs.speak !== false; $('speak').onchange = function () { vs.speak = $('speak').checked; save('eltra-hud-voice', vs); if (!$('speak').checked) hush(); };
  $('convo').checked = !!vs.convo; $('convo').onchange = function () { vs.convo = $('convo').checked; save('eltra-hud-voice', vs); };
  $('testVoice').onclick = function () { unlockAudio(); var was = $('speak').checked; $('speak').checked = true; speak('G’day ' + me.name + ', I’m Eltra. This is how I’ll sound when I read out your brief.'); $('speak').checked = was; };
  // ElevenLabs' own short sample of the voice (free, doesn't use your characters)
  $('playSample').onclick = function () {
    unlockAudio(); hush(); speakSeq++;
    var v = $('voiceSel').value;
    if (v.indexOf('dv:') === 0) { speaking = true; deviceSpeak('G’day, this is how this voice sounds.', false); return; }
    var hit = voices && voices.voices ? voices.voices.filter(function (x) { return 'el:' + x.id === v; })[0] : null;
    if (!hit || !hit.preview) { voiceNotice('There’s no sample for this voice. Try Test voice instead.'); return; }
    speaking = true; setState('speaking', 'Playing sample'); player.onplaying = null;
    player.onended = function () { afterSpeech(false); };
    player.onerror = function () { voiceNotice('Couldn’t play the sample.'); afterSpeech(false); };
    player.src = hit.preview; player.play().catch(function () { voiceNotice('Couldn’t play the sample.'); afterSpeech(false); });
  };
  try { speechSynthesis.addEventListener('voiceschanged', fillVoices); } catch (e) {}

  // ================= voice in: record, stop on silence, transcribe =================
  var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  var stream = null, recorder = null, chunks = [], listening = false, vad = null, ac = null, cancelRec = false, forceSend = false;
  function mimeType() { var t = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']; for (var i = 0; i < t.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t[i])) return t[i]; return ''; }
  function stopListening(cancel, manual) {
    cancelRec = !!cancel; forceSend = !!manual;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    if (srRec) { srStopped = true; try { if (cancel) srRec.abort(); else srRec.stop(); } catch (e) {} }
  }
  var followUp = false, noSpeech = false, starting = false, dropReason = null, autoTry = false;
  // ---- mic health: iPhone Home Screen apps lose the mic when backgrounded or locked, so watch for it and say so ----
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function iosStandalone() { return isIOS && (navigator.standalone === true || !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches)); }
  var micBlocked = false, resumeMic = false, micPerm = null, micInfo = load('eltra-mic', {});
  function micHint(t) { $('vHint').textContent = t; }
  // a dead or muted stream (iOS kills it in the background) has to be asked for again
  function liveStream() { return !!stream && stream.getAudioTracks().some(function (t) { return t.readyState === 'live' && !t.muted; }); }
  function releaseStream() {
    if (!stream) return;
    stream.getTracks().forEach(function (t) { t.onended = t.onmute = t.onunmute = null; try { t.stop(); } catch (e) {} });
    stream = null;
  }
  function micOff(msg) { setState('off', 'Mic off, tap to restart'); micHint(msg || 'Listening stopped unexpectedly. Tap the mic to start again.'); }
  function micDenied() {
    micBlocked = true; noteLoss();
    setState('denied', 'Mic blocked');
    micHint(isIOS ? 'Microphone access is off. Go to Settings, Safari, Microphone, choose Allow, then tap the mic. You can still type.'
      : 'Microphone access is blocked. Allow it for this site in your browser settings (by the address bar), then tap the mic. You can still type.');
  }
  // Plain-language messages for everything the mic or speech recognition can report.
  function micError(code) {
    var auto = autoTry; autoTry = false;
    if (busy) return;
    if (code === 'not-allowed' || code === 'NotAllowedError' || code === 'SecurityError' || code === 'PermissionDeniedError' || code === 'denied') {
      // iOS can refuse a restart that wasn't started by a tap; that isn't a blocked mic, so just ask for a tap
      if (auto && code !== 'denied' && !(micPerm && micPerm.state === 'denied')) return micOff('Tap the mic to pick up where you left off.');
      return micDenied();
    }
    if (code === 'no-speech') { setState('idle', 'Didn’t hear anything'); micHint('I didn’t hear anything. Tap the mic and try again, a little closer.'); return; }
    if (code === 'ended') noteLoss();
    micOff({
      'audio-capture': 'Couldn’t reach the microphone. Another app (a call, Siri or a recording) may be using it. Tap the mic to try again.',
      NotFoundError: 'No microphone found. Check one is connected, then tap the mic.',
      NotReadableError: 'Couldn’t reach the microphone. Another app (a call, Siri or a recording) may be using it. Tap the mic to try again.',
      network: 'Voice recognition needs an internet connection. Check your signal, then tap the mic.',
      'service-not-allowed': 'Speech recognition is turned off on this device. Turn on Siri & Dictation in Settings, or use the keyboard mic.',
      'language-not-supported': 'This device can’t recognise Australian English speech. Use the keyboard mic instead.',
      aborted: 'Listening was interrupted. Tap the mic to start again.',
      hidden: 'Listening paused while Eltra was in the background. Tap the mic to start again.',
      ended: 'The microphone dropped out. Tap the mic to start again.',
      silent: 'The microphone isn’t sending any sound. Tap the mic to restart it.'
    }[code]);
  }
  // Count mic losses in the Home Screen app; if it keeps happening, show a one-time tip on how to fix it for good.
  function noteLoss() {
    if (!iosStandalone()) return;
    micInfo.losses = (micInfo.losses || 0) + 1; save('eltra-mic', micInfo);
    if (micInfo.losses >= 2 && !micInfo.tipped) {
      micInfo.tipped = true; save('eltra-mic', micInfo);
      var t = $('voiceToast'); t.textContent = 'Tip: the Home Screen app keeps losing the microphone. Open Eltra in Safari and allow the mic there, then go to Settings, Safari, Microphone and choose Allow. Tap to close.';
      t.hidden = false; t.style.cursor = 'pointer'; t.onclick = function () { t.hidden = true; t.onclick = null; t.style.cursor = ''; };
      clearTimeout(noticeT); noticeT = setTimeout(function () { t.hidden = true; }, 20000);
    }
  }
  function checkMicPermission() {
    try {
      return navigator.permissions.query({ name: 'microphone' }).then(function (p) {
        if (!micPerm) { micPerm = p; p.onchange = function () { permChanged(p.state); }; }
        if (p.state === 'prompt' && micInfo.granted && iosStandalone()) { micInfo.granted = false; save('eltra-mic', micInfo); noteLoss(); }   // permission was reset
        return p.state;
      }).catch(function () { return 'unknown'; });
    } catch (e) { return Promise.resolve('unknown'); }
  }
  function permChanged(st) {
    if (st === 'denied') { if (listening || srRec) { dropReason = 'denied'; stopListening(true); } else if (!busy) micDenied(); releaseStream(); return; }
    if (st === 'granted') micBlocked = false;
    if (orb.dataset.state === 'denied' && !busy) { setState('idle', 'Ready'); wakeHint(); }
  }
  function startListening(isFollowUp) {
    if (listening || busy || starting) return;
    if (isFollowUp === true && micBlocked) return;   // don't keep re-asking after every reply while the mic is blocked
    followUp = isFollowUp === true; autoTry = isFollowUp === 'auto'; dropReason = null;
    wakeStop();
    hush(); unlockAudio();
    if (!canRecord || !(voices && voices.configured)) return startFallback();
    cancelRec = false;
    if (stream && !liveStream()) releaseStream();
    starting = true;
    var go = stream ? Promise.resolve(stream) : navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    go.then(function (s) {
      starting = false; stream = s; autoTry = false;
      if (busy || document.hidden) { if (document.hidden) { resumeMic = true; if (isIOS) releaseStream(); } return; }
      chunks = [];
      micBlocked = false; if (!micInfo.granted) { micInfo.granted = true; save('eltra-mic', micInfo); }
      // the mic track ending or going mute mid-recording (call, Siri, screen lock) is a drop-out, not silence
      var muteT = null;
      s.getAudioTracks().forEach(function (t) {
        t.onended = function () { if (listening && stream === s) { dropReason = 'ended'; stopListening(true); } if (stream === s) releaseStream(); };
        t.onmute = function () { clearTimeout(muteT); muteT = setTimeout(function () { if (t.muted && listening && stream === s) { dropReason = 'ended'; stopListening(true); releaseStream(); } }, 1200); };
        t.onunmute = function () { clearTimeout(muteT); };
      });
      var mt = mimeType(); recorder = new MediaRecorder(s, mt ? { mimeType: mt } : undefined);
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onerror = function () { if (listening) { dropReason = 'audio-capture'; stopListening(true); } };
      recorder.onstop = function () {
        listening = false; clearInterval(vad); clearTimeout(muteT); orb.style.removeProperty('--lvl');
        var blob = new Blob(chunks, { type: (recorder.mimeType || 'audio/webm').split(';')[0] });
        if (dropReason) { var why = dropReason; dropReason = null; noSpeech = false; releaseStream(); micError(why); return; }
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
      if (ac.state !== 'running') { try { ac.resume().catch(function () {}); } catch (e) {} }   // iOS leaves it 'suspended' or 'interrupted' after the background
      var src = ac.createMediaStreamSource(s), an = ac.createAnalyser(); an.fftSize = 1024; src.connect(an);
      // Speech detection that adapts to the room: it learns the background level and listens for anything clearly above it.
      // Float samples (not 8-bit) so quiet voices at a distance still register. Sensitivity is set in Settings.
      var buf = new Float32Array(an.fftSize), heard = false, quietSince = 0, startAt = Date.now(), noise = 0, peak = 0, deadSince = 0;
      var sens = { normal: 1, high: 0.7, max: 0.5 }[vs.sens || 'high'] || 0.7;
      vad = setInterval(function () {
        an.getFloatTimeDomainData(buf); var sum = 0; for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        var rms = Math.sqrt(sum / buf.length), now = Date.now();
        orb.style.setProperty('--lvl', Math.min(14, rms * 160).toFixed(1) + 'px');
        // a real mic always has some hiss: a few seconds of perfect zero means the mic has dropped out, not that the room is quiet
        if (rms === 0 || ac.state !== 'running') { if (!deadSince) deadSince = now; if (!heard && now - deadSince > 3000) { dropReason = 'silent'; stopListening(true); return; } } else deadSince = 0;
        if (now - startAt < 250) { noise = noise ? Math.min(noise, rms) : rms; return; }   // background, taken from the quietest moment
        var gate = Math.max(0.006, Math.min(noise, 0.03) * 2.4) * sens;
        peak = Math.max(peak, rms);
        if (rms > gate) { heard = true; quietSince = 0; }
        else {
          noise = noise * 0.96 + rms * 0.04;   // keep learning the room while it's quiet
          if (heard) { if (!quietSince) quietSince = now; if (now - quietSince > 1500) stopListening(false); }
        }
        if (!heard && now - startAt > (followUp ? 6000 : 8000)) {
          if (peak > gate * 0.6) { heard = true; stopListening(false); }   // something faint was said: let transcription decide
          else { noSpeech = true; stopListening(true); }
        }
        if (now - startAt > 45000) stopListening(false);
      }, 80);
      recorder.start(250); listening = true; setState('listening', 'Listening');
    }).catch(function (e) {
      starting = false; var n = e && e.name;
      if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') { micError(n); return; }   // blocked: say how to fix it, try again on the next tap
      if (n === 'NotFoundError' || n === 'NotReadableError' || n === 'AbortError') { micError(n === 'NotFoundError' ? n : 'NotReadableError'); return; }
      canRecord = false; micHint('Recording isn’t available here, so using speech recognition or the keyboard mic.'); startFallback();
    });
  }
  // fallback 1: browser speech recognition; fallback 2: keyboard dictation with auto-send
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition, armed = false, quiet = null, srRec = null, srStopped = false;
  function startFallback() {
    if (SR) {
      try {
        var rec = new SR(), text = '', err = null; rec.lang = 'en-AU'; rec.interimResults = true;
        rec.onresult = function (e) { text = ''; for (var i = 0; i < e.results.length; i++) text += e.results[i][0].transcript; $('askIn').value = text; };
        // only give up on speech recognition for good when the device can't do it; a blocked mic or a dropout can be retried
        rec.onerror = function (e) { err = (e && e.error) || 'aborted'; if (err === 'service-not-allowed' || err === 'language-not-supported') SR = null; };
        rec.onend = function () {
          if (srRec !== rec) return;
          srRec = null; listening = false; if (busy) return;
          var why = dropReason; dropReason = null;
          if (text.trim() && !why) { setState('idle', 'Ready'); ask(text); return; }
          if (why) { micError(why); return; }
          if (srStopped) { setState('idle', 'Ready'); return; }
          micError(err || 'no-speech');   // ended on its own without hearing anything: say so instead of going quiet
        };
        srStopped = false; srRec = rec; rec.start(); listening = true; setState('listening', 'Listening'); return;
      } catch (e) { srRec = null; SR = null; }
    }
    $('askIn').value = ''; $('askIn').focus(); armed = true; setState('listening', 'Dictate now');
    $('vHint').textContent = 'Use the mic key on your keyboard. It sends when you stop.';
  }
  $('askIn').addEventListener('input', function () { clearTimeout(quiet); if (!armed || busy) return; quiet = setTimeout(function () { if (armed && $('askIn').value.trim()) { armed = false; ask($('askIn').value); } }, 2200); });
  $('askIn').addEventListener('keydown', function (e) { if (e.key !== 'Enter' && e.key !== 'Unidentified') armed = false; });
  $('askIn').addEventListener('blur', function () { clearTimeout(quiet); armed = false; if (!busy && orb.dataset.state === 'listening' && !listening) setState('idle', 'Ready'); });
  orb.onclick = function () { unlockAudio(); if (busy) return; if (speaking) { hush(); setState('idle', 'Ready'); return; } if (listening) { stopListening(false, true); return; } startListening(false); };
  document.addEventListener('keydown', function (e) { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); orb.click(); } });
  // Screen lock / app switch: stop cleanly and remember it was on. Back in the foreground: re-check permission and pick up again.
  function micAway() {
    if (listening || srRec || starting) { resumeMic = true; dropReason = 'hidden'; stopListening(true); }
    if (isIOS) releaseStream();   // iOS kills the mic in the background anyway; a fresh one is asked for on return
  }
  function micBack() {
    checkMicPermission().then(function (st) {
      if (document.hidden) return;
      if (st === 'denied') { resumeMic = false; if (!busy && !listening) micDenied(); return; }
      if (st === 'granted') micBlocked = false;
      if (orb.dataset.state === 'denied' && st === 'granted' && !busy) { setState('idle', 'Ready'); wakeHint(); }
      if (resumeMic) { resumeMic = false; setTimeout(function () { if (!busy && !speaking && !listening && !document.hidden) startListening('auto'); }, 400); }
    });
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) micAway(); else micBack(); });
  window.addEventListener('pagehide', micAway);
  window.addEventListener('pageshow', function (e) { if (e.persisted && !document.hidden) micBack(); });
  checkMicPermission().then(function (st) { if (st === 'denied' && !busy) micDenied(); });

  // ================= wake word: say "Eltra" =================
  // Uses the browser's own speech recognition to listen for the name while the page is open (Chrome, Edge, Safari).
  // "Eltra, brief me" asks straight away; "Eltra" on its own starts normal listening for the question.
  var WSR = window.SpeechRecognition || window.webkitSpeechRecognition, wakeRec = null, wakeOn = !!vs.wake && !!WSR, asleep = false;
  // "Eltra Energy" (the company) never counts as her name
  var WAKE = /\b(eltra|el tra|elltra|eltrah|elta|electra|ultra|altra)\b(?![\s,]*energy)[\s,.!?]*/i;
  var quietUntil = 0, lastSaid = '';
  // Fuzzy match for the name. Speech services write "Eltra" as all sorts: ultra, altra, elta, electra, el tra, alter…
  // A close word counts on its own; a looser one counts after "hey"/"hi"/"okay". "Eltra Energy" (the company) never does.
  var WAKE_WORDS = ['eltra', 'eltrah', 'elltra', 'eltre', 'eltro', 'ultra', 'altra', 'oltra', 'iltra', 'elta', 'electra', 'eltron', 'elter', 'alter', 'eltera', 'eltrar'];
  function lev(a, b) {
    var d = []; for (var x = 0; x <= a.length; x++) { d[x] = [x]; } for (var y = 0; y <= b.length; y++) d[0][y] = y;
    for (x = 1; x <= a.length; x++) for (y = 1; y <= b.length; y++) d[x][y] = Math.min(d[x - 1][y] + 1, d[x][y - 1] + 1, d[x - 1][y - 1] + (a[x - 1] === b[y - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  function findWake(t) {
    var re = /[A-Za-z']+/g, w, words = [];
    while ((w = re.exec(String(t)))) words.push({ s: w[0].toLowerCase().replace(/'/g, ''), i: w.index, end: w.index + w[0].length });
    for (var k = 0; k < words.length; k++) {
      var cur = words[k], nxt = words[k + 1], prev = words[k - 1], joined = nxt ? cur.s + nxt.s : '';
      var cand = [{ s: cur.s, end: cur.end }]; if (nxt && /^(el|l|elle|al|ell)$/.test(cur.s)) cand.push({ s: joined, end: nxt.end });
      for (var c = 0; c < cand.length; c++) {
        var x = cand[c].s, after = words.slice(k + 1).find(function (q) { return q.i >= cand[c].end; });
        if (after && after.s === 'energy') continue;
        var greeted = prev && /^(hey|hi|hay|okay|ok|oi|yo|morning|evening)$/.test(prev.s);
        var everyday = /^(ultra|alter|elter|electra)$/.test(x) && !greeted && k > 0;   // real English words only count at the start or after "hey"
        if (!everyday && (WAKE_WORDS.indexOf(x) >= 0 || (x.length >= 4 && lev(x, 'eltra') <= 1) || (greeted && x.length >= 4 && lev(x, 'eltra') <= 2))) {
          var endPos = cand[c].end; while (/[\s,.!?]/.test(String(t).charAt(endPos))) endPos++;
          return { index: cur.i, end: endPos };
        }
      }
    }
    return null;
  }
  var heardTimer = null;
  function lastHeard(t) { var el = $('wakeHeard'); if (!el || !t) return; el.textContent = 'Last heard: “' + String(t).trim().slice(0, 80) + '”'; clearTimeout(heardTimer); heardTimer = setTimeout(function () { el.textContent = ''; }, 15000); }
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
    r.lang = 'en-AU'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 5;
    r.onresult = function (e) {
      if (fired) return;
      for (var i = e.resultIndex; i < e.results.length; i++) {
        // the speech service has never heard of "Eltra", so check every guess it offers, not just the top one
        var t = null, m = null;
        for (var a = 0; a < e.results[i].length && !m; a++) { t = e.results[i][a].transcript; m = findWake(t); }
        lastHeard(e.results[i][0].transcript);
        if (!m || echoOfHer(t)) continue;
        var rest = t.slice(m.end).trim();
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
  $('micSens').value = vs.sens || 'high';
  $('micSens').onchange = function () { vs.sens = $('micSens').value; save('eltra-hud-voice', vs); };
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
    if (st.instagram && st.instagram.setUp && !st.instagram.connected) down.push('Instagram');
    if (!D) return 'Systems are still coming online.';
    return down.length ? 'All systems are up, except ' + down.join(' and ') + '.' : 'All systems are up.';
  }
  function greeting(said) {
    var n = new Date(), h = +n.toLocaleString('en-AU', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
    var t = String(said || '').toLowerCase();
    var tod = h < 5 ? 'evening' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
    var sir = isEthan() ? 'Ethan' : 'sir';
    var first = /\b(i'?m|im|i am) (home|back)\b|\bhome\b/.test(t) ? (isEthan() ? 'Welcome back, Ethan. Good ' + tod + '.' : 'Welcome home, sir. Good ' + tod + '.')
      : /\b(hello|hi|hey)\b/.test(t) && Math.random() < 0.5 ? 'Hello, ' + sir + '. Good ' + tod + '.'
      : 'Good ' + tod + ', ' + sir + '.';
    var bits = [], reply = parseInt($('sReply').textContent, 10);
    var tdy = new Date().toLocaleDateString('en-CA', { timeZone: TZ }), od = 0, dt = 0;
    (todos.items || []).forEach(function (x) { if (!x.done && x.due && mine(x)) { if (x.due < tdy) od++; else if (x.due === tdy) dt++; } });
    if (od) bits.push(od === 1 ? 'one to-do is overdue' : od + ' to-dos are overdue');
    if (dt) bits.push(dt === 1 ? 'one to-do is due today' : dt + ' to-dos are due today');
    if (reply > 0) bits.push(reply === 1 ? 'one email needs a reply' : reply + ' emails need replies');
    var now = Date.now(), nx = events.filter(function (e) { return !e.allDay && e.start.getTime() > now; })[0];
    if (nx) {
      var sameDay = fmt(nx.start, { day: 'numeric', month: 'numeric' }) === fmt(n, { day: 'numeric', month: 'numeric' });
      var tmr = fmt(nx.start, { day: 'numeric', month: 'numeric' }) === fmt(new Date(now + 86400000), { day: 'numeric', month: 'numeric' });
      bits.push('next up is ' + (nx.title || 'an appointment') + ' at ' + fmt(nx.start, { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }).replace(/\s/g, '').toLowerCase() + (sameDay ? '' : tmr ? ' tomorrow' : ' on ' + fmt(nx.start, { weekday: 'long' })));
    }
    var joined = bits.length > 1 ? bits.slice(0, -1).join(', ') + ', and ' + bits[bits.length - 1] : bits[0] || '';
    var line = bits.length ? ' ' + joined.replace(/^./, function (c) { return c.toUpperCase(); }) + '.' : ' All quiet for now.';
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
    var fw = findWake(said), rest = String(said || '').slice(fw ? fw.end : 0)
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

  // ================= carousel slide images (1080×1350) =================
  var logoImg = new Image(); logoImg.src = 'logo.png';
  function wrapLines(ctx, text, maxW) {
    var out = []; String(text || '').split('\n').forEach(function (para) {
      var line = ''; para.split(/\s+/).forEach(function (w) { var t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }); out.push(line);
    }); return out;
  }
  function fitText(ctx, text, font, maxW, maxH, start, min, lh) {
    var size = start, lines; do { ctx.font = font.replace('{s}', size); lines = wrapLines(ctx, text, maxW); if (lines.length * size * lh <= maxH) break; size -= 4; } while (size > min);
    return { size: size, lines: lines };
  }
  function drawSlide(cv, car, i, scale) {
    var ctx = cv.getContext('2d'), W = 1080, H = 1350, sl = car.slides[i], n = car.slides.length, blue = i === 0 || i === n - 1;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = blue ? '#1F6FE0' : '#FFFFFF'; ctx.fillRect(0, 0, W, H);
    if (!blue) { ctx.fillStyle = '#1F6FE0'; ctx.fillRect(0, 0, 18, H); ctx.fillRect(0, H - 120, W, 120); }
    var pad = 110, ink = blue ? '#FFFFFF' : '#14263D';
    var hd = fitText(ctx, sl.heading, '700 {s}px "Barlow Semi Condensed", Barlow, Arial, sans-serif', W - pad * 2, blue ? 640 : 480, blue ? 112 : 84, 44, 1.08);
    var y = blue && !sl.body ? (H - hd.lines.length * hd.size * 1.08) / 2 : blue ? 300 : 230;
    ctx.fillStyle = ink; ctx.textBaseline = 'top'; ctx.font = '700 ' + hd.size + 'px "Barlow Semi Condensed", Barlow, Arial, sans-serif';
    hd.lines.forEach(function (l) { ctx.fillText(l, pad, y); y += hd.size * 1.08; });
    if (sl.body) {
      y += 50; var bd = fitText(ctx, sl.body, '500 {s}px Barlow, Arial, sans-serif', W - pad * 2, (blue ? H - 260 : H - 200) - y, 52, 30, 1.32);
      ctx.fillStyle = blue ? 'rgba(255,255,255,.88)' : '#3E5068'; ctx.font = '500 ' + bd.size + 'px Barlow, Arial, sans-serif';
      bd.lines.forEach(function (l) { ctx.fillText(l, pad, y); y += bd.size * 1.32; });
    }
    if (n > 1) { ctx.fillStyle = blue ? 'rgba(255,255,255,.75)' : '#5D6E82'; ctx.font = '600 34px Barlow, Arial, sans-serif'; ctx.textAlign = 'right'; ctx.fillText((i + 1) + ' / ' + n, W - pad, 90); ctx.textAlign = 'left'; }
    if (logoImg.complete && logoImg.naturalWidth) { var lh = 64, lw = lh * logoImg.naturalWidth / logoImg.naturalHeight; ctx.drawImage(logoImg, pad, H - 92, lw, lh); }
    else logoImg.onload = function () { drawSlide(cv, car, i, scale); };
  }
  function igConnected() { return !!(D && D.status && D.status.instagram && D.status.instagram.connected); }
  // Instagram fetches images from a public link, so upload JPEG versions of the slides and hand Eltra the links
  function postCarousel(car, btn) {
    btn.disabled = true; btn.textContent = 'Preparing slides…';
    var fontsReady = document.fonts && document.fonts.load ? Promise.all([document.fonts.load('700 100px "Barlow Semi Condensed"'), document.fonts.load('500 50px Barlow')]).catch(function () {}) : Promise.resolve();
    fontsReady.then(function () {
      var datas = car.slides.map(function (sl, i) { var cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1350; drawSlide(cv, car, i, 1); return cv.toDataURL('image/jpeg', 0.92); });
      return Promise.all(datas.map(function (d) { return api('media', { method: 'POST', body: { data: d } }); }));
    }).then(function (rs) {
      btn.textContent = 'Sent to Eltra'; ask('Post this carousel to Instagram with the caption we wrote for it. Slide links, in order: ' + rs.map(function (r) { return r.url; }).join(' '));
    }).catch(function (e) { btn.disabled = false; btn.textContent = 'Post to Instagram'; $('vHint').textContent = 'Couldn’t prepare the slides: ' + e.message; });
  }
  function saveCarousel(car, btn) {
    var fontsReady = document.fonts && document.fonts.load ? Promise.all([document.fonts.load('700 100px "Barlow Semi Condensed"'), document.fonts.load('500 50px Barlow')]).catch(function () {}) : Promise.resolve();
    fontsReady.then(function () { saveCarouselNow(car, btn); });
  }
  function saveCarouselNow(car, btn) {
    var files = car.slides.map(function (sl, i) { var cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1350; drawSlide(cv, car, i, 1); return cv; });
    Promise.all(files.map(function (cv, i) { return new Promise(function (ok) { cv.toBlob(function (b) { ok(new File([b], 'eltra-slide-' + (i + 1) + '.png', { type: 'image/png' })); }, 'image/png'); }); })).then(function (fs) { saveFiles(fs, btn); });
  }
  function saveFiles(fs, btn) {
    if (navigator.canShare && navigator.canShare({ files: fs })) { navigator.share({ files: fs }).catch(function () {}); return; }   // iPhone/iPad: "Save Image(s)" puts them in Photos
    fs.forEach(function (f, i) { setTimeout(function () { var a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); }, i * 250); });
    var old = btn.textContent; btn.textContent = fs.length > 1 ? 'Saved ' + fs.length + ' images' : 'Saved'; setTimeout(function () { btn.textContent = old; }, 2500);
  }

  // ================= branded wallpapers (phone and desktop) =================
  // Logo and tagline sit in a middle band, clear of the clock up top and the dock / lock screen buttons at the bottom.
  function drawWallpaper(cv, wp, key, scale) {
    var z = WP_SIZES[key], W = z.w, H = z.h, tall = H > W, u = Math.min(W, H), ctx = cv.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.textAlign = 'left';
    var g = ctx.createLinearGradient(0, 0, W * 0.4, H); g.addColorStop(0, '#2C80F0'); g.addColorStop(0.55, '#1F6FE0'); g.addColorStop(1, '#14489A');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // soft sun glow and rings in a corner (background only, low contrast)
    var cx = W * (tall ? 0.85 : 0.88), cy = H * (tall ? 0.12 : 0.16), rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, u * 0.95);
    rg.addColorStop(0, 'rgba(255,255,255,.22)'); rg.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = u * 0.005;
    for (var k = 1; k <= 5; k++) { ctx.beginPath(); ctx.arc(cx, cy, u * 0.22 * k, 0, Math.PI * 2); ctx.stroke(); }
    // safe band: phones 36%–80% of the height (lock screen clock above, dock / torch and camera below); desktops 14%–84% (menu bar, taskbar / dock)
    var top = H * (tall ? 0.36 : 0.14), bot = H * (tall ? 0.80 : 0.84);
    var ready = logoImg.complete && logoImg.naturalWidth, lw = W * (tall ? 0.66 : 0.34), lh = lw * (ready ? logoImg.naturalHeight / logoImg.naturalWidth : 125 / 640);
    var t = null, gap = lh * 0.5, lineH = 1.2, font = '600 {s}px "Barlow Semi Condensed", Barlow, Arial, sans-serif';
    if (wp.tagline) { var start = Math.round(W * (tall ? 0.068 : 0.03)); t = fitText(ctx, wp.tagline, font, tall ? W * 0.8 : W * 0.5, (bot - top) * 0.3, start, Math.round(start * 0.6), lineH); }
    var block = lh + (t ? gap + t.lines.length * t.size * lineH : 0), y = (top + bot) / 2 - block / 2;
    if (ready) ctx.drawImage(logoImg, (W - lw) / 2, y, lw, lh);
    else logoImg.addEventListener('load', function () { drawWallpaper(cv, wp, key, scale); }, { once: true });
    if (t) {
      y += lh + gap; ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.textBaseline = 'top'; ctx.textAlign = 'center'; ctx.font = font.replace('{s}', t.size);
      t.lines.forEach(function (l) { ctx.fillText(l, W / 2, y); y += t.size * lineH; });
      ctx.textAlign = 'left';
    }
  }
  function saveWallpaper(wp, key, btn) {
    var z = WP_SIZES[key]; if (!wp || !z) return;
    var fontsReady = document.fonts && document.fonts.load ? Promise.all([document.fonts.load('600 100px "Barlow Semi Condensed"')]).catch(function () {}) : Promise.resolve();
    var logoReady = logoImg.complete && logoImg.naturalWidth ? Promise.resolve() : new Promise(function (ok) { logoImg.addEventListener('load', ok, { once: true }); logoImg.addEventListener('error', ok, { once: true }); });
    Promise.all([fontsReady, logoReady]).then(function () {
      var cv = document.createElement('canvas'); cv.width = z.w; cv.height = z.h; drawWallpaper(cv, wp, key, 1);
      cv.toBlob(function (b) { saveFiles([new File([b], 'eltra-wallpaper-' + z.w + 'x' + z.h + '.png', { type: 'image/png' })], btn); }, 'image/png');
    });
  }

  // ================= photos and PDFs in the chat =================
  // Photos are shrunk on this device (long side 1600px) before sending. Once Eltra has answered, they're swapped for a short
  // note in the saved chat so it stays small; she remembers what she saw from her own reply.
  var pendingAtt = [];
  function renderAtt() {
    var box = $('attList'); box.textContent = ''; box.hidden = !pendingAtt.length;
    pendingAtt.forEach(function (p, i) {
      var d = document.createElement('span'); d.className = 'attchip';
      d.innerHTML = (p.thumb ? '<img alt="" src="' + p.thumb + '">' : '<b>' + (p.loading ? '…' : 'PDF') + '</b>') + '<span>' + esc(p.name) + '</span><button type="button" aria-label="Remove ' + esc(p.name) + '">×</button>';
      d.querySelector('button').onclick = function () { pendingAtt.splice(i, 1); renderAtt(); };
      box.appendChild(d);
    });
  }
  function addFiles(files) {
    Array.prototype.slice.call(files || []).slice(0, 4 - pendingAtt.length).forEach(function (f) {
      if (/^image\//.test(f.type)) {
        var p = { name: f.name || 'photo', loading: true }; pendingAtt.push(p); renderAtt();
        var url = URL.createObjectURL(f), img = new Image();
        img.onload = function () {
          var k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
          c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          var data = c.toDataURL('image/jpeg', 0.85); URL.revokeObjectURL(url);
          var k2 = Math.min(1, 200 / Math.max(img.width, img.height)), t = document.createElement('canvas'); t.width = Math.round(img.width * k2); t.height = Math.round(img.height * k2); t.getContext('2d').drawImage(img, 0, 0, t.width, t.height); p.small = t.toDataURL('image/jpeg', 0.7);
          p.thumb = data; p.block = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data.split(',')[1] } };
          if (igConnected()) api('media', { method: 'POST', body: { data: data } }).then(function (r) { p.url = r.url; }).catch(function () {}).then(function () { p.loading = false; renderAtt(); });
          else { p.loading = false; renderAtt(); }
        };
        img.onerror = function () { pendingAtt.splice(pendingAtt.indexOf(p), 1); renderAtt(); $('vHint').textContent = 'Couldn’t open that photo. Try a JPEG or PNG.'; };
        img.src = url;
      } else if (f.type === 'application/pdf') {
        if (f.size > 3.5e6) { $('vHint').textContent = 'That PDF is over 3.5 MB. Save it to Drive and ask Eltra to read it from there.'; return; }
        var q = { name: f.name || 'document.pdf', loading: true }; pendingAtt.push(q); renderAtt();
        var r = new FileReader(); r.onload = function () { q.loading = false; q.block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: String(r.result).split(',')[1] } }; renderAtt(); }; r.readAsDataURL(f);
      } else { $('vHint').textContent = 'Eltra can take photos (JPEG, PNG, HEIC from iPhone) and PDFs.'; }
    });
  }
  function stripAttachments() {
    chat.messages.forEach(function (m) {
      if (m.role !== 'user' || !Array.isArray(m.content)) return;
      m.content = m.content.map(function (c) { return c.type === 'image' ? { type: 'text', text: '[Attached photo, already viewed]' } : c.type === 'document' ? { type: 'text', text: '[Attached PDF, already read]' } : c; });
    });
  }
  $('attBtn').onclick = function () { $('attFile').click(); };
  $('attFile').onchange = function () { addFiles(this.files); this.value = ''; };
  $('askIn').addEventListener('paste', function (e) { var fs = e.clipboardData && e.clipboardData.files; if (fs && fs.length) { e.preventDefault(); addFiles(fs); } });
  $('chatDrawer').addEventListener('dragover', function (e) { e.preventDefault(); });
  $('chatDrawer').addEventListener('drop', function (e) { e.preventDefault(); addFiles(e.dataTransfer.files); });

  // ================= drawers: chat and settings stay out of the way until needed =================
  function openDrawer(which) {
    var c = $('chatDrawer'), st = $('setDrawer');
    c.hidden = which !== 'chat'; st.hidden = which !== 'settings'; $('scrim').hidden = false;
    if (which === 'settings') loadPortals();
    if (which === 'chat') { $('chatBtn').classList.remove('has'); var lg = $('log'); lg.scrollTop = lg.scrollHeight; }
  }
  function closeDrawers() { $('chatDrawer').hidden = true; $('setDrawer').hidden = true; $('scrim').hidden = true; }
  $('chatBtn').onclick = function () { if ($('chatDrawer').hidden) openDrawer('chat'); else closeDrawers(); };
  $('gearBtn').onclick = function () { openDrawer('settings'); };
  $('sysPill').onclick = function () { openDrawer('settings'); };
  $('scrim').onclick = closeDrawers;
  document.querySelectorAll('[data-close]').forEach(function (b) { b.onclick = closeDrawers; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawers(); });

  function fallbackCopy(t) { var ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove(); }

  // ================= DNSP portal links (Settings) =================
  function loadPortals() {
    return api('prefs').then(function (p) {
      var box = $('portalList'); box.textContent = '';
      Object.keys(p.portals || {}).forEach(function (n) {
        var l = document.createElement('label'); l.textContent = n;
        var i = document.createElement('input'); i.type = 'url'; i.placeholder = 'https://… (the page you log in to)'; i.value = p.portals[n] || ''; i.dataset.dnsp = n;
        l.appendChild(i); box.appendChild(l);
      });
    }).catch(function () {});
  }
  $('savePortals').onclick = function () {
    var portals = {}; document.querySelectorAll('#portalList [data-dnsp]').forEach(function (i) { portals[i.dataset.dnsp] = i.value.trim(); });
    $('portalMsg').textContent = 'Saving…';
    api('prefs', { method: 'POST', body: { portals: portals } }).then(function () { $('portalMsg').textContent = 'Saved'; loadPortals(); }).catch(function (e) { $('portalMsg').textContent = e.message; });
  };

  // ================= visit prep and log-out setting =================
  function prepVisit(ev) {
    var when = fmt(ev.start, { weekday: 'long', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    ask('Prep me for my visit: "' + ev.title + '" on ' + when + (ev.location ? ' at ' + ev.location : '') + (ev.who && ev.who.name ? ' with ' + ev.who.name : '') + '. Find the customer in Pylon and GoHighLevel, their bill and any recent emails, and give me a one-screen brief: who they are, what they want or were quoted, their usage and bill, anything to watch for, and what to bring.');
  }
  $('nextMeta').addEventListener('click', function (e) { if (e.target.closest('#prepVisit') && nextEv) prepVisit(nextEv); });
  $('cal').addEventListener('click', function (e) { var b = e.target.closest('[data-prepev]'); if (!b) return; var ev = events[+b.dataset.prepev]; if (ev) prepVisit(ev); });
  try { $('clearOnOut').checked = localStorage.getItem('eltra-keep-chat') !== '1'; } catch (e) {}
  $('clearOnOut').onchange = function () { try { localStorage.setItem('eltra-keep-chat', $('clearOnOut').checked ? '0' : '1'); } catch (e) {} };

  // ================= content schedule =================
  var CS = { items: [], settings: {} }, DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], openPost = null;
  var STATUS = { planned: 'Planned', draft: 'Needs OK', scheduled: 'Scheduled', manual: 'To film', posted: 'Posted', failed: 'Failed', skipped: 'Skipped' };
  function loadContent() { return api('content').then(function (d) { CS = d; renderContent(); }).catch(function () {}); }
  function contentCall(body) { return api('content', { method: 'POST', body: body }).then(function (d) { CS = d; renderContent(); return d; }); }
  function whenText(it) { var t = new Date(it.at); return { day: t.toLocaleDateString('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }), time: t.toLocaleTimeString('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) }; }
  function renderContent() {
    var list = $('contList'); list.textContent = '';
    var items = (CS.items || []).filter(function (x) { return x.status !== 'skipped' || Date.parse(x.at) > Date.now(); });
    panelCount('contH', items.length);
    if (!items.length) { var e = document.createElement('p'); e.className = 'note'; e.textContent = 'Eltra is planning the week. Drafts appear here within about half an hour, and each one waits for your OK.'; list.appendChild(e); }
    // group by day; every upcoming weekday gets an "Add my own idea" button, even when it's empty or was deleted
    var byDate = {}, dates = [], today = dayKey(new Date());
    items.forEach(function (it) { var k = it.date || dayKey(new Date(it.at)); if (!byDate[k]) { byDate[k] = []; dates.push(k); } byDate[k].push(it); });
    upcomingWeekdays().forEach(function (k) { if (!byDate[k]) { byDate[k] = []; dates.push(k); } });
    dates.sort();
    dates.forEach(function (k) {
      if (isWeekday(k) && k >= today) {
        var hd = document.createElement('div'); hd.className = 'cday';
        hd.innerHTML = '<span>' + esc(dateLabel(k)) + (byDate[k].length ? '' : ' · nothing planned') + '</span>';
        var ad = document.createElement('button'); ad.type = 'button'; ad.className = 'copy'; ad.textContent = 'Add my own idea';
        ad.onclick = function () { openAddIdea(k); };
        hd.appendChild(ad); list.appendChild(hd);
      }
      byDate[k].forEach(function (it) {
        var w = whenText(it), line = document.createElement('div'), b = document.createElement('button'); line.className = 'cline'; b.type = 'button'; b.className = 'crow'; b.setAttribute('role', 'row');
        b.innerHTML = '<span class="when"><b>' + esc(w.day) + '</b><small>' + esc(w.time) + '</small></span><span class="fmt">' + esc(it.format) + '</span><span class="topic">' + (it.own ? '<span class="ownb">Own idea</span> ' : '') + esc(it.topic) + '</span><span class="st ' + esc(it.status) + '">' + esc(it.status === 'manual' && it.format === 'photo' ? 'To post' : STATUS[it.status] || it.status) + '</span>';
        b.onclick = function () { showPost(it.id); };
        line.appendChild(b);
        if (it.status !== 'posted') {
          var del = document.createElement('button'); del.type = 'button'; del.className = 'copy'; del.textContent = 'Delete'; del.setAttribute('aria-label', 'Delete ' + w.day + ' post: ' + it.topic);
          del.onclick = function () { if (confirm('Delete this post from the schedule for good? Eltra won’t plan another one for that date.')) contentCall({ action: 'delete', id: it.id }).catch(function (er) { alert(er.message); }); };
          line.appendChild(del);
        }
        list.appendChild(line);
      });
    });
    var nSkip = (CS.items || []).filter(function (x) { return x.status === 'skipped'; }).length;
    if (nSkip) {
      var cl = document.createElement('button'); cl.type = 'button'; cl.className = 'btn no'; cl.textContent = 'Clear ' + nSkip + ' skipped post' + (nSkip > 1 ? 's' : '');
      cl.onclick = function () { if (confirm('Delete every skipped post from the schedule? Eltra won’t plan those dates again.')) contentCall({ action: 'clear_skipped' }).catch(function (e) { alert(e.message); }); };
      list.appendChild(cl);
    }
    var needs = items.filter(function (x) { return x.status === 'draft'; }).length, last = CS.log && CS.log[0];
    $('contStatus').textContent = (needs ? needs + ' post' + (needs > 1 ? 's need' : ' needs') + ' your OK. ' : '') + (CS.settings && CS.settings.paused ? 'Planning is paused. ' : '') + (last ? 'Latest: ' + last.msg + '.' : '');
    $('contWorksBox').textContent = CS.learnings && CS.learnings.text ? CS.learnings.text : 'Nothing yet. Once Instagram is connected and a few posts are out, Eltra reviews the numbers weekly and notes what works.';
    var st = CS.settings || {}; $('contDays').textContent = '';
    [1, 2, 3, 4, 5, 6, 0].forEach(function (n) { var l = document.createElement('label'); l.innerHTML = '<input type="checkbox" value="' + n + '"' + ((st.days || []).indexOf(n) >= 0 ? ' checked' : '') + '> ' + DOW[n]; $('contDays').appendChild(l); });
    $('contTime').value = st.time || '18:30'; $('contReels').value = st.reelsPerWeek != null ? st.reelsPerWeek : 1; $('contPaused').checked = !!st.paused;
    if (openPost) { var cur = (CS.items || []).find(function (x) { return x.id === openPost; }); if (cur && $('postDlg').open && !$('postDlg').dataset.dirty) fillPost(cur); }
  }
  // ---- add my own idea by hand (weekdays only) ----
  function isWeekday(k) { var n = new Date(k + 'T12:00:00Z').getUTCDay(); return n >= 1 && n <= 5; }
  function dateLabel(k) { return new Date(k + 'T12:00:00Z').toLocaleDateString('en-AU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }); }
  function upcomingWeekdays() { var out = [], n = (CS.settings && CS.settings.aheadDays) || 8; for (var i = 0; i <= n; i++) { var k = dayKey(new Date(Date.now() + i * 864e5)); if (isWeekday(k)) out.push(k); } return out; }
  function openAddIdea(k) {
    var today = dayKey(new Date()); $('contAddDate').min = today; $('contAddDate').value = k || ''; $('contAddErr').hidden = true;
    $('contAdd').hidden = false; $('contAddIdea').focus();
  }
  $('contAddCancel').onclick = function () { $('contAdd').hidden = true; };
  $('contAddSave').onclick = function () {
    var k = $('contAddDate').value, idea = $('contAddIdea').value.trim(), err = function (m) { $('contAddErr').textContent = m; $('contAddErr').hidden = false; };
    if (!k) return err('Pick a date.');
    if (!isWeekday(k)) return err('Pick a weekday (Monday to Friday).');
    if (k < dayKey(new Date())) return err('That date has already passed.');
    if (!idea) return err('Write your topic or idea.');
    var b = $('contAddSave'); b.disabled = true;
    contentCall({ action: 'add', date: k, format: $('contAddFmt').value, idea: idea })
      .then(function () { $('contAdd').hidden = true; $('contAddIdea').value = ''; })
      .catch(function (e) { err(e.message); })
      .then(function () { b.disabled = false; });
  };
  $('contSet').onclick = function () { $('contSettings').hidden = !$('contSettings').hidden; };
  $('contWorks').onclick = function () { $('contWorksBox').hidden = !$('contWorksBox').hidden; };
  $('contSaveSet').onclick = function () {
    var days = []; $('contDays').querySelectorAll('input:checked').forEach(function (i) { days.push(+i.value); });
    contentCall({ action: 'settings', days: days, time: $('contTime').value, reelsPerWeek: +$('contReels').value, paused: $('contPaused').checked }).then(function () { $('contSettings').hidden = true; });
  };
  function showPost(id) { var it = (CS.items || []).find(function (x) { return x.id === id; }); if (!it) return; openPost = id; $('postDlg').dataset.dirty = ''; fillPost(it); $('postDlg').showModal(); }
  function fillPost(it) {
    var w = whenText(it), b = $('pdBody'), f = $('pdFoot'), editable = ['draft', 'planned', 'failed'].indexOf(it.status) >= 0 || it.status === 'scheduled';
    $('pdTitle').textContent = w.day + ' ' + w.time + ' · ' + it.format; $('pdErr').hidden = true;
    var h = '<div class="meta"><b>' + esc(it.topic) + '</b><br>' + esc(it.angle || '') + '</div>';
    if (it.status === 'planned') h += '<p class="note">Eltra hasn’t drafted this one yet. It’ll be ready within about half an hour.</p>';
    if (it.format === 'carousel' && it.slides) {
      h += '<div class="slides">' + it.slides.map(function (sl, i) { return '<canvas class="slide" width="216" height="270" data-ps="' + i + '"></canvas>'; }).join('') + '</div>';
      h += it.slides.map(function (sl, i) { return '<div class="sl"><span>' + (i + 1) + '</span><input data-sh="' + i + '" value="' + esc(sl.heading) + '" aria-label="Slide ' + (i + 1) + ' heading"' + (editable ? '' : ' disabled') + '><input data-sb="' + i + '" value="' + esc(sl.body || '') + '" aria-label="Slide ' + (i + 1) + ' text"' + (editable ? '' : ' disabled') + '></div>'; }).join('');
    }
    if (it.format === 'reel' && it.script) h += '<div><div class="meta">Hooks, scored</div><ul>' + (it.hooks || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div><label>Script<pre>' + esc(it.script) + '</pre></label>' + (it.shots ? '<label>What to film<pre>' + esc(it.shots) + '</pre></label>' : '') + (it.beats && it.beats.length ? '<div class="meta">' + it.beats.map(esc).join('<br>') + '</div>' : '');
    if (it.format === 'photo' && it.photo) h += '<label>Photo to use<pre>' + esc(it.photo) + '</pre></label>';
    if (it.format === 'story' && it.frames) h += '<label>Story frames<pre>' + it.frames.map(function (x, i) { return (i + 1) + '. ' + esc(x); }).join('\n') + '</pre></label>';
    if (it.format !== 'story' && it.caption != null && it.status !== 'planned') h += '<label>Caption<textarea id="pdCap"' + (editable ? '' : ' disabled') + '>' + esc(it.caption || '') + '</textarea></label>' + (it.check ? '<div class="meta">Checks: ' + esc([it.check.verdict && 'humanizer ' + it.check.verdict, it.check.caption && 'caption ' + it.check.caption, it.check.hook && 'hook ' + it.check.hook].filter(Boolean).join(' · ')) + '</div>' : '');
    if (it.status === 'posted') h += '<p><a href="' + esc(it.link || '#') + '" target="_blank" rel="noopener">View the post on Instagram</a></p>';
    if (it.status === 'failed') h += '<p class="note err">Didn’t post: ' + esc(it.error || 'unknown error') + '</p>';
    if (it.approvedBy) h += '<div class="meta">Approved by ' + esc(it.approvedBy === me.user ? 'you' : it.approvedBy === 'ethan' ? 'Ethan' : 'Will') + '</div>';
    b.innerHTML = h;
    b.querySelectorAll('input,textarea').forEach(function (el) { el.addEventListener('input', function () { $('postDlg').dataset.dirty = '1'; redrawPost(); }); });
    redrawPost();
    var btn = function (label, cls, fn) { var x = document.createElement('button'); x.type = 'button'; x.className = 'btn' + (cls ? ' ' + cls : ''); x.textContent = label; x.onclick = fn; f.appendChild(x); return x; };
    f.textContent = '';
    if (it.status === 'draft' || it.status === 'failed') {
      btn('Skip', 'no', function () { postAction({ action: 'skip' }); });
      btn('Redraft…', 'no', function () { var fb = prompt('What should Eltra change?'); if (fb !== null) postAction({ action: 'redraft', feedback: fb }); });
      btn('Save changes', 'no', function () { postAction(edits()); });
      btn(it.format === 'carousel' ? 'Approve & schedule' : 'Approve', '', function (e) { approvePost(it, e.target); });
    } else if (it.status === 'manual' && it.format === 'photo') {
      btn('Post to Instagram', '', function () { postPhoto(it); });
    } else if (it.status === 'scheduled') {
      btn('Unschedule', 'no', function () { postAction({ action: 'unapprove' }); });
    } else if (it.status === 'planned') {
      btn('Skip', 'no', function () { postAction({ action: 'skip' }); });
    }
    if (it.status !== 'posted') btn('Delete', 'no', function () { if (confirm('Delete this post from the schedule for good? Eltra won’t plan another one for that date.')) postAction({ action: 'delete' }); });
  }
  function currentSlides() { var out = []; $('pdBody').querySelectorAll('[data-sh]').forEach(function (el) { var i = +el.dataset.sh; out[i] = { heading: el.value, body: ($('pdBody').querySelector('[data-sb="' + i + '"]') || {}).value || '' }; }); return out; }
  function redrawPost() { var sl = currentSlides(); if (!sl.length) return; var car = { slides: sl }; $('pdBody').querySelectorAll('canvas.slide').forEach(function (cv) { drawSlide(cv, car, +cv.dataset.ps, 0.2); }); }
  function edits() { var e = {}; if ($('pdCap')) e.caption = $('pdCap').value; var sl = currentSlides(); if (sl.length) e.slides = sl; return e; }
  function postAction(body) {
    body.id = openPost; return contentCall(body).then(function () { $('postDlg').dataset.dirty = ''; if (body.action) $('postDlg').close(); })
      .catch(function (e) { $('pdErr').textContent = e.message; $('pdErr').hidden = false; });
  }
  function approvePost(it, b) {
    var e = edits();
    if (it.format !== 'carousel') { e.action = 'approve'; return postAction(e); }
    if (!igConnected()) { $('pdErr').textContent = 'Connect Instagram first (Settings → Connections) so Eltra can post it.'; $('pdErr').hidden = false; return; }
    b.disabled = true; b.textContent = 'Preparing slides…';
    var car = { slides: e.slides }, daysLeft = Math.ceil((Date.parse(it.at) - Date.now()) / 864e5) + 3;
    var fontsReady = document.fonts && document.fonts.load ? Promise.all([document.fonts.load('700 100px "Barlow Semi Condensed"'), document.fonts.load('500 50px Barlow')]).catch(function () {}) : Promise.resolve();
    fontsReady.then(function () {
      return Promise.all(car.slides.map(function (sl, i) { var cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1350; drawSlide(cv, car, i, 1); return api('media', { method: 'POST', body: { data: cv.toDataURL('image/jpeg', 0.92), days: daysLeft } }); }));
    }).then(function (rs) { e.action = 'approve'; e.image_urls = rs.map(function (r) { return r.url; }); return postAction(e); })
      .catch(function (err) { b.disabled = false; b.textContent = 'Approve & schedule'; $('pdErr').textContent = err.message; $('pdErr').hidden = false; });
  }
  // a photo slot: attach the photo in the chat, and Eltra posts it with instagram_post using its "saved for posting" link
  function postPhoto(it) {
    if (!igConnected()) { $('pdErr').textContent = 'Connect Instagram first (Settings → Connections) so Eltra can post it.'; $('pdErr').hidden = false; return; }
    var w = whenText(it);
    $('postDlg').close(); openDrawer('chat');
    $('askIn').value = 'Post this photo to Instagram for the ' + w.day + ' photo slot "' + it.topic + '" (content_id ' + it.id + ') with its caption from the schedule.';
    $('vHint').textContent = 'Attach the photo, then send.';
    $('attFile').click();
  }
  $('pdClose').onclick = function () { $('postDlg').close(); };

  // ================= improvement ideas =================
  function loadImprove() { return api('improve').then(renderImprove).catch(function () {}); }
  var impPoll = null, IMP = { items: [], canBuild: {} };
  var APPNAME = { eltra: 'Eltra', quote: 'Quote app' };
  var IMP_ACTIVE = ['proposed', 'approved', 'building', 'built', 'failed'];
  var IMP_STATUS = { proposed: 'Waiting for approval', approved: 'Approved · to build', building: 'Building', built: 'Ready to test', failed: 'Didn’t build', live: 'Live', undone: 'Undone', rejected: 'Declined' };
  var impOpen = {}, impShowDone = false, impCollapsed = load('eltra-imp-collapsed', false);
  function impSetCollapsed(v) { impCollapsed = v; save('eltra-imp-collapsed', v); $('impBody').hidden = v; $('impToggle').setAttribute('aria-expanded', v ? 'false' : 'true'); }
  $('impToggle').onclick = function () { impSetCollapsed(!impCollapsed); };
  $('impShowDone').checked = false;
  $('impShowDone').onchange = function () { impShowDone = $('impShowDone').checked; renderImprove(); };
  impSetCollapsed(impCollapsed);
  function renderImprove(d) {
    IMP = d || IMP;
    var all = IMP.items || [];
    var active = all.filter(function (x) { return IMP_ACTIVE.indexOf(x.status) >= 0; });
    var done = all.filter(function (x) { return IMP_ACTIVE.indexOf(x.status) < 0; })
      .sort(function (a, b) { return Date.parse(b.build && (b.build.liveAt || b.build.undoneAt) || b.decidedAt || b.createdAt || 0) - Date.parse(a.build && (a.build.liveAt || a.build.undoneAt) || a.decidedAt || a.createdAt || 0); });
    var items = impShowDone ? active.concat(done) : active;
    var box = $('impList'); box.textContent = '';
    var learned = all.filter(function (x) { return x.kind === 'behaviour' && x.status === 'live'; });
    $('impPanel').hidden = !all.length && isEthan();   // Will always sees it, for “Install an update”
    $('impUp').hidden = isEthan();
    $('impCount').textContent = active.length + ' pending';
    $('impLearnedCount').textContent = learned.length ? learned.length + ' learned' : '';
    if (learned.length) {
      var lh = document.createElement('details'); lh.className = 'learned';
      lh.innerHTML = '<summary>What Eltra has learned (' + learned.length + ')</summary>' + learned.map(function (x) { return '<div class="lrow"><span>' + esc(x.change) + '</span><button type="button" class="copy" data-unlearn="' + esc(x.id) + '">Remove</button></div>'; }).join('');
      lh.querySelectorAll('[data-unlearn]').forEach(function (b) { b.onclick = function () { if (confirm('Stop following this rule?')) decideImp(b.dataset.unlearn, 'reject'); }; });
      box.appendChild(lh);
    }
    if (!items.length) { var none = document.createElement('p'); none.className = 'imp-none'; none.textContent = done.length ? 'Nothing waiting. Tick “Show completed” to see past ideas.' : 'Nothing waiting.'; box.appendChild(none); }
    items.forEach(function (it) {
      var b = it.build || {}, feature = it.kind !== 'behaviour', upd = it.kind === 'update', tgt = it.target || 'eltra', can = IMP.canBuild && IMP.canBuild[tgt];
      var el = document.createElement('div'); el.className = 'imp' + (impOpen[it.id] ? ' open' : '') + (IMP_ACTIVE.indexOf(it.status) < 0 ? ' past' : '');
      var line = '<div class="line"><button type="button" class="tt" aria-expanded="' + (impOpen[it.id] ? 'true' : 'false') + '"><span class="car" aria-hidden="true">▸</span><b>' + esc(it.title) + '</b></button><span class="st st-' + esc(it.status) + '">' + esc(IMP_STATUS[it.status] || it.status) + '</span><span class="qa"></span></div>';
      var head = '<div class="t"><span class="k">' + (upd ? 'Uploaded update · ' + APPNAME[tgt] : feature ? 'New feature · ' + APPNAME[tgt] : 'How Eltra works · goes live on approval') + '</span></div>';
      var body = '';
      if (['proposed', 'approved', 'rejected'].indexOf(it.status) >= 0 || (it.status === 'live' && !b.liveAt)) body = '<div class="why">' + esc(it.why) + '</div><div class="chg">' + esc(it.change) + '</div>';
      if (it.status === 'building' && upd) body = '<div class="bstat">⏳ Netlify is building a preview of this update. Usually 1 to 3 minutes; it appears here when it’s ready. ' + (b.prUrl ? '<a href="' + esc(b.prUrl) + '" target="_blank" rel="noopener">See it on GitHub</a>' : '') + '</div>' + (b.summary ? '<details class="sum"><summary>What’s in the update</summary><pre>' + esc(b.summary) + '</pre></details>' : '');
      else if (it.status === 'building') body = '<div class="bstat">⏳ Claude is building it in ' + APPNAME[tgt] + '’s code. Usually 2 to 10 minutes; the preview appears here when it’s ready. ' + (b.issueUrl ? '<a href="' + esc(b.issueUrl) + '" target="_blank" rel="noopener">See it on GitHub</a>' : '') + '</div>';
      if (it.status === 'built') body = '<div class="bstat ok">✅ Built. Try the preview, then make it live.</div>' + (b.summary ? '<details class="sum"><summary>' + (upd ? 'What’s in the update' : 'What Claude changed') + '</summary><pre>' + esc(b.summary) + '</pre></details>' : '');
      if (it.status === 'failed') body = '<div class="bstat err">Didn’t build: ' + esc(b.error || b.lastError || 'unknown problem') + (b.issueUrl || b.prUrl ? ' <a href="' + esc(b.issueUrl || b.prUrl) + '" target="_blank" rel="noopener">Open on GitHub</a>' : '') + '</div>';
      if (it.status === 'live' && b.liveAt) body = '<div class="bstat ok">Live since ' + esc(new Date(b.liveAt).toLocaleString('en-AU', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' })) + '.' + (b.prUrl ? ' <a href="' + esc(b.prUrl) + '" target="_blank" rel="noopener">The change on GitHub</a>' : '') + '</div>';
      if (it.status === 'undone') body = '<div class="bstat">Undone: the previous version is live again' + (b.revertIssue ? ', and Claude is reverting the code (<a href="' + esc(b.revertIssue) + '" target="_blank" rel="noopener">GitHub</a>)' : '') + '.</div>';
      el.innerHTML = line + '<div class="more"' + (impOpen[it.id] ? '' : ' hidden') + '>' + head + body + '<div class="row"></div></div>';
      var more = el.querySelector('.more'), tt = el.querySelector('.tt');
      el.querySelector('.line').onclick = function (ev) { if (ev.target.closest('.qa')) return; impOpen[it.id] = !impOpen[it.id]; more.hidden = !impOpen[it.id]; el.classList.toggle('open', !!impOpen[it.id]); tt.setAttribute('aria-expanded', impOpen[it.id] ? 'true' : 'false'); };
      var row = el.querySelector('.row'), add = function (label, cls, fn, into) { var x = document.createElement('button'); x.type = 'button'; x.className = 'btn' + (cls ? ' ' + cls : ''); x.textContent = label; x.onclick = fn; (into || row).appendChild(x); return x; };
      if (it.status === 'proposed') {
        var qa = el.querySelector('.qa');
        add('Approve', 'sm', function (e) { approveImp(it, e.target); }, qa).title = feature && can ? 'Approve and start building' : 'Approve';
        add('Decline', 'sm no', function () { decideImp(it.id, 'reject'); }, qa);
        if (feature) add('For: ' + APPNAME[tgt] + ' ⇄', 'no', function () { impCall({ id: it.id, action: 'target', target: tgt === 'eltra' ? 'quote' : 'eltra' }); });
      } else if (it.status === 'approved') {
        add('Copy build brief', '', function (ev) { var t = 'Eltra improvement to build (approved): ' + it.title + '\nWhy: ' + it.why + '\n\n' + it.change; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).catch(function () { fallbackCopy(t); }).then(function () { ev.target.textContent = 'Copied ✓'; }); });
        if (can) add('Build it now', 'no', function () { impCall({ id: it.id, action: 'retry' }); });
        add('Mark as live', 'no', function () { decideImp(it.id, 'done'); });
      } else if (it.status === 'building') {
        add('Check now', 'no', function () { loadImprove(); });
        add('Cancel', 'no', function () { if (confirm('Cancel this build?')) impCall({ id: it.id, action: 'discard' }); });
      } else if (it.status === 'built') {
        if (b.previewUrl) { var a = document.createElement('a'); a.className = 'btn'; a.href = b.previewUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Try the preview'; row.appendChild(a); }
        add('Make it live', b.previewUrl ? 'no' : '', function (e) { if (!confirm('Make this change live in ' + APPNAME[tgt] + '?')) return; e.target.disabled = true; e.target.textContent = 'Going live…'; impCall({ id: it.id, action: 'live' }); });
        add('Discard', 'no', function () { if (confirm('Throw this change away?')) impCall({ id: it.id, action: 'discard' }); });
      } else if (it.status === 'failed') {
        if (!upd) add('Try again', '', function () { impCall({ id: it.id, action: 'retry' }); });
        add('Discard', 'no', function () { impCall({ id: it.id, action: 'discard' }); });
      } else if (it.status === 'live' && b.previousDeploy) {
        add('Undo', 'no', function () { if (confirm('Put the previous version of ' + APPNAME[tgt] + ' back live?')) impCall({ id: it.id, action: 'undo' }); });
      }
      box.appendChild(el);
    });
    // while something is building, keep checking every minute
    var busyNow = active.some(function (x) { return x.status === 'building'; });
    if (busyNow && !impPoll) impPoll = setInterval(loadImprove, 60000);
    if (!busyNow && impPoll) { clearInterval(impPoll); impPoll = null; }
  }
  function impCall(body) { return api('improve', { method: 'POST', body: body }).then(renderImprove).catch(function (e) { alert(e.message); loadImprove(); }); }
  function approveImp(it, btn) {
    btn.disabled = true; btn.textContent = 'Starting…';
    api('improve', { method: 'POST', body: { id: it.id, action: 'approve' } }).then(renderImprove).catch(function (e) {
      if (/logins|sensitive/i.test(e.message) && confirm('This change touches logins, passwords or keys. Are you sure you want Claude to build it?')) return impCall({ id: it.id, action: 'approve', confirmSensitive: true });
      btn.disabled = false; btn.textContent = 'Approve'; if (!/logins|sensitive/i.test(e.message)) alert(e.message);
    });
  }
  // ---- install an update from a zip (Will only): read the zip here, confirm the file list, then open a pull request ----
  var impUp = null;   // { target, name, files: [{ path, data }] } waiting for Will's OK
  function upMsg(t, err) { var m = $('impUpMsg'); m.textContent = t || ''; m.hidden = !t; m.className = 'impupmsg' + (err ? ' err' : ''); }
  function upReset() { impUp = null; $('impUpFile').value = ''; $('impUpList').textContent = ''; $('impUpRow').hidden = true; upMsg(''); }
  $('impUpBtn').onclick = function () { var f = $('impUpForm'), open = f.hidden; f.hidden = !open; $('impUpBtn').setAttribute('aria-expanded', open ? 'true' : 'false'); if (!open) upReset(); };
  $('impUpCancel').onclick = function () { upReset(); $('impUpForm').hidden = true; $('impUpBtn').setAttribute('aria-expanded', 'false'); };
  $('impUpApp').onchange = function () { if (impUp) impUp.target = $('impUpApp').value; };
  // read a .zip with no libraries: the central directory lists the files; entries are stored or deflated
  function readZip(buf) {
    var dv = new DataView(buf), u8 = new Uint8Array(buf), end = -1;
    for (var i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) return Promise.reject(new Error('That doesn’t look like a zip file.'));
    var count = dv.getUint16(end + 10, true), off = dv.getUint32(end + 16, true);
    if (count === 0xffff || off === 0xffffffff) return Promise.reject(new Error('That zip is too big to read here.'));
    var dec = new TextDecoder(), list = [];
    for (var n = 0; n < count; n++) {
      if (off + 46 > buf.byteLength || dv.getUint32(off, true) !== 0x02014b50) return Promise.reject(new Error('That zip file looks damaged.'));
      var flags = dv.getUint16(off + 8, true), method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true), size = dv.getUint32(off + 24, true);
      var nl = dv.getUint16(off + 28, true), xl = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true), local = dv.getUint32(off + 42, true);
      list.push({ name: dec.decode(u8.subarray(off + 46, off + 46 + nl)).replace(/\\/g, '/'), flags: flags, method: method, csize: csize, size: size, local: local });
      off += 46 + nl + xl + cl;
    }
    return list.map(function (e) {
      e.read = function () {
        if (e.flags & 1) return Promise.reject(new Error(e.name + ' is password-protected.'));
        if (dv.getUint32(e.local, true) !== 0x04034b50) return Promise.reject(new Error('That zip file looks damaged.'));
        var start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true), data = u8.subarray(start, start + e.csize);
        if (e.method === 0) return Promise.resolve(data);
        if (e.method !== 8) return Promise.reject(new Error(e.name + ' uses a zip format I can’t read.'));
        if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('This browser can’t unzip files. Try Chrome or Safari.'));
        return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
      };
      return e;
    });
  }
  function toB64(u8) { var s = '', CH = 0x8000; for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
  function upKeep(p) { return /^(netlify|public)\/./.test(p) || /^[^\/]+\.md$/i.test(p); }
  $('impUpFile').onchange = function () {
    var file = $('impUpFile').files[0]; impUp = null; $('impUpList').textContent = ''; $('impUpRow').hidden = true;
    if (!file) return upMsg('');
    if (file.size > 20 * 1024 * 1024) return upMsg('That zip is too big (20 MB max).', true);
    upMsg('Reading ' + file.name + '…');
    file.arrayBuffer().then(readZip).then(function (entries) {
      // drop folders and Mac clutter, then strip one wrapper folder if everything sits inside it
      var es = entries.filter(function (e) { return !/\/$/.test(e.name) && !/(^|\/)__MACOSX\//.test(e.name) && !/(^|\/)\.DS_Store$/.test(e.name); });
      var tops = {}; es.forEach(function (e) { tops[e.name.indexOf('/') > 0 ? e.name.split('/')[0] : ''] = 1; });
      var top = Object.keys(tops);
      if (top.length === 1 && top[0] && !/^(netlify|public)$/.test(top[0])) es.forEach(function (e) { e.name = e.name.slice(top[0].length + 1); });
      var keep = es.filter(function (e) { return upKeep(e.name) && !/(^|\/)\.\.?(\/|$)|\/\//.test(e.name); }), skipped = es.length - keep.length;
      if (!keep.length) throw new Error('There’s nothing to install: the zip needs files in netlify/, public/ or top-level .md files.');
      return Promise.all(keep.map(function (e) { return e.read().then(function (d) { return { path: e.name, size: d.length, data: toB64(d) }; }); })).then(function (files) {
        files.sort(function (a, b) { return a.path.localeCompare(b.path); });
        var bytes = JSON.stringify(files).length;
        if (bytes > 4.9 * 1024 * 1024) throw new Error('That update is too big to install from here (5 MB max once packed).');
        var tgt = $('impUpApp').value;
        impUp = { target: tgt, name: file.name, files: files.map(function (f) { return { path: f.path, data: f.data }; }) };
        var kb = function (n) { return n < 1024 ? n + ' B' : Math.round(n / 102.4) / 10 + ' KB'; };
        $('impUpList').innerHTML = '<ul class="impupl">' + files.map(function (f) { return '<li>' + esc(f.path) + ' <small>' + kb(f.size) + '</small></li>'; }).join('') + '</ul>';
        upMsg(files.length + ' file' + (files.length === 1 ? '' : 's') + ' to install' + (skipped ? ' (' + skipped + ' other file' + (skipped === 1 ? '' : 's') + ' ignored)' : '') + '. Check the list and pick the app, then Install. Nothing goes live until you press “Make it live”.');
        $('impUpRow').hidden = false;
      });
    }).catch(function (e) { impUp = null; upMsg(e.message, true); });
  };
  $('impUpGo').onclick = function () {
    if (!impUp) return;
    var tgt = $('impUpApp').value, go = $('impUpGo');
    if (IMP.canBuild && !IMP.canBuild[tgt]) return upMsg('Code updates for ' + APPNAME[tgt] + ' aren’t set up yet (GitHub token or repo missing in Netlify).', true);
    if (!confirm('Install these ' + impUp.files.length + ' files into ' + APPNAME[tgt] + '? This makes a preview first; it goes live only when you press “Make it live”.')) return;
    go.disabled = true; go.textContent = 'Installing…'; upMsg('Sending the files to GitHub…');
    api('install-update', { method: 'POST', body: { target: tgt, name: impUp.name, files: impUp.files } }).then(function (d) {
      upReset(); $('impUpForm').hidden = true; $('impUpBtn').setAttribute('aria-expanded', 'false');
      if (d.item) impOpen[d.item.id] = true;
      return loadImprove();
    }).catch(function (e) { upMsg(e.message, true); }).then(function () { go.disabled = false; go.textContent = 'Install'; });
  };
  function decideImp(id, action) { api('improve', { method: 'POST', body: { id: id, action: action } }).then(renderImprove).catch(function () {}); }

  // ================= to-do list =================
  var todos = { sections: [], items: [] }, todoTab = 'All', showDone = false, todoWho = 'mine';
  function mine(x) { return !x.owner || x.owner === me.user || x.owner === 'both'; }
  var OWNER = { will: 'Will', ethan: 'Ethan', both: 'Both' };
  function todoDueText(d) {
    if (!d) return null;
    var today = fmt(new Date(), { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-');
    var t = new Date(d + 'T12:00:00'), cls = d < today ? 'over' : d === today ? 'today' : '';
    var txt = d === today ? 'Today' : d < today ? 'Overdue · ' + t.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : t.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
    return { cls: cls, txt: txt };
  }
  // urgency: the one set on the to-do (red / yellow / green), else from its due date: overdue or today red, within 3 days yellow, later green
  var URG = { red: { rank: 0, label: 'Urgent' }, yellow: { rank: 1, label: 'Soon' }, green: { rank: 2, label: 'Can wait' } };
  function todoUrgency(x) {
    if (URG[x.urgency]) return x.urgency;
    if (!x.due) return '';
    var today = fmt(new Date(), { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-');
    var days = Math.round((Date.parse(x.due + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 864e5);
    return days <= 0 ? 'red' : days <= 3 ? 'yellow' : 'green';
  }
  // "Parent - Sub" sections (e.g. "DNSP - Pre approval") show under one parent tab. The stored names don't change.
  // todoTab is 'All', a section name, or '*' + parent name for a whole parent tab; todoOpen is the parent that's opened out.
  var todoOpen = '';
  function secParts(sname) { var m = /^(.+?)\s+-\s+(.+)$/.exec(sname || ''); return m ? { parent: m[1], sub: m[2] } : null; }
  function todoGroups() {
    var groups = [], byName = {};
    todos.sections.forEach(function (sname) {
      var p = secParts(sname), key = (p ? p.parent : sname).toLowerCase(), g = byName[key];
      if (!g) { g = byName[key] = { name: p ? p.parent : sname, secs: [], subs: false }; groups.push(g); }
      g.secs.push(sname); if (p) g.subs = true;
    });
    return groups;
  }
  function tabHas(tab, x) {
    if (tab === 'All') return true;
    if (tab.charAt(0) === '*') { var p = secParts(x.section), key = tab.slice(1).toLowerCase(); return (p ? p.parent : x.section).toLowerCase() === key; }
    return x.section === tab;
  }
  function tabLabel(tab) { return tab.charAt(0) === '*' ? tab.slice(1) : tab; }
  function tabExists(tab) {
    if (tab === 'All') return true;
    if (tab.charAt(0) === '*') return todoGroups().some(function (g) { return g.subs && g.name === tab.slice(1); });
    return todos.sections.indexOf(tab) >= 0;
  }
  function renderTodos() {
    var secs = $('todoSecs'), subs = $('todoSubs'); secs.textContent = ''; subs.textContent = '';
    var count = function (tab) { return todos.items.filter(function (x) { return !x.done && (todoWho === 'all' || mine(x)) && tabHas(tab, x); }).length; };
    if (!tabExists(todoTab)) todoTab = 'All';
    var groups = todoGroups(), openG = null;
    var tabBtn = function (label, tab, n, parent) {
      var b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', tab === todoTab);
      b.innerHTML = esc(label) + (n ? '<span class="n">' + n + '</span>' : '');
      parent.appendChild(b); return b;
    };
    // top row: All, then each plain section or parent tab. On "Mine", only show the ones where you actually have something to do
    tabBtn('All', 'All', count('All'), secs).onclick = function () { todoTab = 'All'; renderTodos(); };
    groups.forEach(function (g) {
      var tab = g.subs ? '*' + g.name : g.name, inG = g.subs && (todoTab === tab || g.secs.indexOf(todoTab) >= 0), n = count(tab);
      if (todoWho !== 'all' && !n && !inG && tab !== todoTab) return;
      if (!g.subs) { tabBtn(g.name, tab, n, secs).onclick = function () { todoTab = tab; $('todoSec').value = tab; renderTodos(); }; return; }
      var isOpen = todoOpen === g.name, b = tabBtn(g.name, tab, n, secs);
      if (inG) b.setAttribute('aria-selected', 'true');
      b.setAttribute('aria-expanded', isOpen); b.setAttribute('aria-controls', 'todoSubs');
      b.innerHTML += '<span class="car" aria-hidden="true">' + (isOpen ? '▾' : '▸') + '</span>';
      if (isOpen) openG = g;
      // first click opens it out (showing the whole group); clicking it again folds the sub-sections away
      b.onclick = function () { if (todoOpen === g.name && inG) todoOpen = ''; else { todoOpen = g.name; if (!inG) todoTab = tab; } renderTodos(); };
    });
    // second row: the opened parent's sub-sections, each with its own count
    subs.hidden = !openG;
    if (openG) {
      var all = '*' + openG.name;
      tabBtn('All ' + openG.name, all, count(all), subs).onclick = function () { todoTab = all; renderTodos(); };
      openG.secs.forEach(function (sname) {
        var p = secParts(sname), n = count(sname);
        // DNSP sub-sections always show, in their fixed order, even when empty (Will asked for this)
        if (todoWho !== 'all' && !n && sname !== todoTab && !/^dnsp$/i.test(openG.name)) return;
        tabBtn(p ? p.sub : 'General', sname, n, subs).onclick = function () { todoTab = sname; $('todoSec').value = sname; renderTodos(); };
      });
    }
    // "Add" section picker: sub-sections sit under their parent's heading
    var sel = $('todoSec'), cur = sel.value; sel.textContent = '';
    groups.forEach(function (g) {
      var into = sel;
      if (g.subs) { into = document.createElement('optgroup'); into.label = g.name; sel.appendChild(into); }
      g.secs.forEach(function (sname) { var o = document.createElement('option'), p = secParts(sname); o.value = sname; o.textContent = g.subs ? (p ? p.sub : 'General') : sname; into.appendChild(o); });
    });
    var inTabSecs = todos.sections.filter(function (sname) { return tabHas(todoTab, { section: sname }); });
    sel.value = inTabSecs.indexOf(cur) >= 0 ? cur : todoTab !== 'All' && todoTab.charAt(0) !== '*' ? todoTab : (inTabSecs[0] || todos.sections[0]);
    var inTab = todos.items.filter(function (x) { return (todoWho === 'all' || mine(x)) && tabHas(todoTab, x); });
    $('todoWho').querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.who === todoWho); });
    // most urgent first (red, yellow, green, then no rating), then by due date, then oldest first
    var urank = function (x) { var u = todoUrgency(x); return u ? URG[u].rank : 3; };
    var open = inTab.filter(function (x) { return !x.done; }).sort(function (a, b) { return urank(a) - urank(b) || ((a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : a.createdAt < b.createdAt ? -1 : 1); });
    var done = inTab.filter(function (x) { return x.done; }).sort(function (a, b) { return (b.doneAt || '') < (a.doneAt || '') ? -1 : 1; });
    var list = $('todoList'); list.textContent = '';
    panelCount('todoH', count('All'));
    if (!open.length) { var e = document.createElement('li'); e.className = 'empty'; e.textContent = todoTab === 'All' ? 'Nothing to do. Add one above, or ask Eltra to.' : 'Nothing in ' + tabLabel(todoTab) + '.'; list.appendChild(e); }
    var shown = open.concat(showDone ? done : []);
    // "All" and a parent tab (e.g. DNSP) list the to-dos under collapsible section and sub-section headers; a single section is a plain list
    var grouped = todoTab === 'All' || todoTab.charAt(0) === '*';
    $('todoColl').hidden = !grouped || !shown.length;
    var groupBox = function (key, label, its, into) {
      var li = document.createElement('li'), k = 'todo:' + key, n = its.filter(function (x) { return !x.done; }).length;
      li.className = 'tgrp';
      li.innerHTML = '<button type="button" class="tgh" data-shut="' + esc(k) + '"><span class="car" aria-hidden="true">▸</span><span>' + esc(label) + '</span>' + (n ? '<span class="n">' + n + '</span>' : '') + '</button><ul class="tlist"></ul>';
      var b = li.firstChild, show = function () { var s = isShut(k); li.classList.toggle('shut', s); b.setAttribute('aria-expanded', s ? 'false' : 'true'); };
      b.onclick = function () { setShut(k, !isShut(k)); show(); };
      show(); into.appendChild(li); return li.lastChild;
    };
    var inSecs = function (secs) { return shown.filter(function (x) { return secs.indexOf(x.section) >= 0; }); };
    var subBoxes = function (g, into) {
      g.secs.forEach(function (sname) {
        var its = inSecs([sname]), p = secParts(sname);
        if (its.length) its.forEach(todoItem.bind(null, groupBox(sname, p ? p.sub : 'General', its, into)));
      });
    };
    if (!grouped) shown.forEach(todoItem.bind(null, list));
    else {
      var known = [];
      groups.forEach(function (g) {
        if (todoTab === 'All') {
          var its = inSecs(g.secs); known = known.concat(g.secs);
          if (!its.length) return;
          var box = groupBox(g.subs ? '*' + g.name : g.name, g.name, its, list);
          if (g.subs) subBoxes(g, box); else its.forEach(todoItem.bind(null, box));
        } else if (g.subs && '*' + g.name === todoTab) { known = g.secs; subBoxes(g, list); }
      });
      // to-dos whose section has since been renamed or removed still show, under "Other"
      var rest = shown.filter(function (x) { return known.indexOf(x.section) < 0; });
      if (rest.length) rest.forEach(todoItem.bind(null, groupBox('~other', 'Other', rest, list)));
    }
    var sd = $('todoShowDone'); sd.hidden = !done.length; sd.textContent = showDone ? 'Hide finished' : 'Show finished (' + done.length + ')';
  }
  function todoItem(list, it) {
      var li = document.createElement('li'), urg = it.done ? '' : todoUrgency(it); li.className = (it.done ? 'done' : '') + (urg ? ' u-' + urg : '');
      if (urg) li.title = URG[urg].label + (it.urgency ? '' : ' (from the due date)');
      var due = todoDueText(it.due);
      li.innerHTML = '<input type="checkbox"' + (it.done ? ' checked' : '') + ' aria-label="Done: ' + esc(it.text) + '">' +
        '<span class="tt" role="button" tabindex="0" title="' + (it.note ? 'Edit or clear the note' : 'Add a note') + '" aria-label="' + (urg ? URG[urg].label + ': ' : '') + esc(it.text) + (it.note ? '. Note: ' + esc(it.note) + '. Edit note' : '. Add a note') + '">' + esc(it.text) + '<small>' + [todos.sections.indexOf(it.section) < 0 ? it.section : '', it.ref, (it.owner && it.owner !== me.user) ? 'for ' + OWNER[it.owner] : ''].filter(Boolean).map(esc).join(' · ') + '</small>' +
        (it.note ? '<small class="tnote"><span aria-hidden="true">📝</span> ' + esc(it.note) + '</small>' : '') + '</span>' +
        '<span class="due ' + (due && !it.done ? due.cls : '') + '">' + (it.meta && it.meta.kind === 'followup' && !it.done ? '<button type="button" class="tdraft" data-draft>Write email</button> ' : '') + (due ? esc(due.txt) : '') + '</span>' +
        '<button type="button" class="x" aria-label="Delete: ' + esc(it.text) + '">×</button>';
      li.querySelector('input').onchange = function (ev) {
        var cb = ev.target, m = cb.checked && /^Book the install date with (.+?)(\s*\(|$)/i.exec(it.text);
        if (!m) { todoCall({ action: 'update', id: it.id, done: cb.checked }); return; }
        // ticking "Book the install date" asks for the date, so the stock, CES and commissioning reminders can run from it
        var who = m[1].trim(), ans = prompt('What date is the install for ' + who + '? (for example 25/11)');
        if (ans === null || !ans.trim()) { cb.checked = false; return; }
        api('jobs', { method: 'POST', body: { name: who, date: ans } })
          .then(function (r) { todoCall({ action: 'update', id: it.id, done: true }); $('vHint').textContent = 'Install for ' + who + ' saved as ' + r.job.installDate + '.'; })
          .catch(function (e) { cb.checked = false; alert(e.message); });
      };
      li.querySelector('.x').onclick = function () { todoCall({ action: 'delete', id: it.id }); };
      // click (or Enter on) a to-do to add, edit or clear its note
      var tt = li.querySelector('.tt');
      tt.onclick = function () {
        var v = prompt('Note for "' + it.text + '" (leave empty to clear it):', it.note || '');
        if (v === null || v.trim() === (it.note || '')) return;
        todoCall({ action: 'update', id: it.id, note: v.trim() });
      };
      tt.onkeydown = function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); tt.onclick(); } };
      var dbtn = li.querySelector('[data-draft]');
      if (dbtn) dbtn.onclick = function () {
        // the follow-up email is written now, in front of you, and is only sent once you approve it (no Gmail draft)
        var m = it.meta;
        openDrawer('chat');
        ask('Write follow-up email ' + m.stage + ' of ' + m.of + ' for ' + m.customer + (m.email ? ' (' + m.email + ')' : '') + ' about their proposal (Pylon project ' + m.projectId + ', sent about ' + m.sentDays + ' days ago). This one should be ' + m.brief + '. Look up the proposal for the system and price, keep it short and friendly, and send it with gmail_send so I can check it and approve it once (don\'t make a Gmail draft).' + (m.email ? '' : ' There is no email address in Pylon for them, so ask me for it.'));
      };
      list.appendChild(li);
  }
  function todoCall(body) {
    $('todoErr').hidden = true;
    return api('todos', { method: 'POST', body: body }).then(function (d) { todos = d; renderTodos(); }).catch(function (e) { $('todoErr').textContent = e.message; $('todoErr').hidden = false; });
  }
  function loadTodos() { return api('todos').then(function (d) { todos = d; renderTodos(); }).catch(function () {}); }
  $('todoForm').onsubmit = function (e) {
    e.preventDefault(); var t = $('todoText').value.trim(); if (!t) return;
    todoCall({ action: 'add', text: t, section: $('todoSec').value, due: $('todoDue').value, owner: $('todoFor').value }).then(function () { $('todoText').value = ''; $('todoDue').value = ''; $('todoText').focus(); });
  };
  // Collapse all / Expand all: every to-do section and sub-section header showing now
  function todoShutAll(v) { $('todoList').querySelectorAll('[data-shut]').forEach(function (b) { setShut(b.dataset.shut, v); }); renderTodos(); }
  $('todoCollAll').onclick = function () { todoShutAll(true); };
  $('todoExpAll').onclick = function () { todoShutAll(false); };
  $('todoShowDone').onclick = function () { showDone = !showDone; renderTodos(); };
  $('todoWho').querySelectorAll('button').forEach(function (b) { b.onclick = function () { todoWho = b.dataset.who; renderTodos(); }; });
  $('todoEditSec').onclick = function () {
    var v = prompt('Sections, separated by commas:', todos.sections.join(', '));
    if (v === null) return;
    todoCall({ action: 'sections', sections: v.split(',').map(function (x) { return x.trim(); }).filter(Boolean) }).then(function () { if (!tabExists(todoTab)) todoTab = 'All'; renderTodos(); });
  };

  // ================= start =================
  function startApp() {
    // each person has their own chat history on this device (Will's keeps its original name)
    CHAT = 'eltra-hud-chat-v1' + (me.user === 'will' ? '' : '-' + me.user);
    chat = load(CHAT, null) || { messages: [], approvals: null, results: {}, decided: {} };
    tick(); setInterval(tick, 1000); setInterval(renderNext, 30000);
    render(); loadToday();
    api('speak').then(gotVoices).catch(function () { voices = null; fillVoices(); });
    if (/(google|instagram)=connected/.test(location.search)) history.replaceState(null, '', '/');
  }
  api('login').then(function (d) { if (d.loggedIn) { if (d.user) me = { user: d.user, name: d.name }; showApp(); } else showLogin(); }).catch(showLogin);
})();
