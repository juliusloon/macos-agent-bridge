/* Static JXA adapter. Untrusted arguments arrive only as JSON argv; never evaluated as source. */
function run(argv) {
  var request = JSON.parse(argv[0]); var a = request.args; var name = request.tool;
  var max = Math.min(100, Math.max(1, a.limit || 100));
  function escapeHTML(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>'); }
  function noteValue(n, body) { var v = { id: n.id(), title: n.name() }; if (body) v.html = n.body(); return v; }
  if (name.indexOf('notes_') === 0) {
    var notes = Application('Notes');
    if (name === 'notes_search') {
      var matches = notes.notes.whose({ name: { _contains: a.query } })();
      return JSON.stringify({ notes: matches.slice(0, max).map(function(n) { return noteValue(n, false); }), truncated: matches.length > max });
    }
    if (name === 'notes_create') {
      var n = notes.Note({ body: '<h1>' + escapeHTML(a.title) + '</h1><div>' + escapeHTML(a.text) + '</div>' });
      notes.defaultAccount.defaultFolder.notes.push(n); return JSON.stringify(noteValue(n, true));
    }
    var found = notes.notes.byId(a.id); if (!found.exists()) throw new Error('Note not found');
    if (name === 'notes_append') found.body = found.body() + '<div>' + escapeHTML(a.text) + '</div>';
    return JSON.stringify(noteValue(found, true));
  }
  if (name.indexOf('mail_') === 0) {
    var mail = Application('Mail');
    function message(m, body) { var v = { id: m.id(), subject: m.subject(), sender: m.sender(), received: m.dateReceived().toISOString(), read: m.readStatus() }; if (body) v.body = m.content(); return v; }
    if (name === 'mail_search' || name === 'mail_read') {
      var inbox = mail.inbox.messages; var count = inbox.length;
      if (name === 'mail_read') { var record = inbox.whose({ id: a.id })(); if (!record.length) throw new Error('Inbox message not found'); return JSON.stringify(message(record[0], true)); }
      var result = []; var visited = 0;
      for (var i = 0; i < Math.min(count, 500); i++) { visited++; var m = inbox[i]; if (m.subject().toLowerCase().indexOf(a.query.toLowerCase()) >= 0) result.push(message(m, false)); if (result.length >= max) break; }
      return JSON.stringify({ messages: result, scanned: visited, truncated: visited < count });
    }
    var outgoing = mail.OutgoingMessage({ subject: a.subject, content: a.body, visible: false }); mail.outgoingMessages.push(outgoing);
    outgoing.toRecipients.push(mail.ToRecipient({ address: a.to }));
    if (name === 'mail_send') { var id = outgoing.id(); var sent = mail.send(outgoing); return JSON.stringify({ id: id, submitted: sent, to: a.to, subject: a.subject, deliveryVerified: false }); }
    outgoing.visible = true; return JSON.stringify({ id: outgoing.id(), to: a.to, subject: a.subject, sent: false });
  }
  if (name.indexOf('safari_') === 0) {
    var safari = Application('Safari');
    if (name === 'safari_list_tabs') return JSON.stringify({ windows: safari.windows().map(function(w) { return { id: w.id(), tabs: w.tabs().map(function(t, i) { return { index: i + 1, title: t.name(), url: t.url() }; }) }; }) });
    if (name === 'safari_open_tab') { if (!/^https?:\/\//i.test(a.url)) throw new Error('Only HTTP(S) URLs'); if (!safari.windows.length) safari.Document().make(); var tab = safari.Tab({ url: a.url }); safari.windows[0].tabs.push(tab); return JSON.stringify({ url: tab.url(), windowId: safari.windows[0].id() }); }
    var window = safari.windows.whose({ id: a.windowId })(); if (!window.length || a.tabIndex > window[0].tabs.length) throw new Error('Tab not found'); var currentURL = window[0].tabs[a.tabIndex - 1].url(); safari.close(window[0].tabs[a.tabIndex - 1]); return JSON.stringify({ closed: true, url: currentURL });
  }
  if (name.indexOf('music_') === 0) {
    var music = Application('Music');
    function track(t) { return { id: t.databaseID(), title: t.name(), artist: t.artist(), album: t.album(), duration: t.duration() }; }
    if (name === 'music_status') { var state = music.playerState(); return JSON.stringify({ state: state, track: state === 'stopped' ? null : track(music.currentTrack) }); }
    if (name === 'music_search') { var tracks = music.libraryPlaylists[0].tracks.whose({ name: { _contains: a.query } })(); return JSON.stringify({ tracks: tracks.slice(0, max).map(track), truncated: tracks.length > max }); }
    if (name === 'music_play_track') { var matches = music.libraryPlaylists[0].tracks.whose({ databaseID: a.id })(); if (!matches.length) throw new Error('Track not found'); music.play(matches[0]); return JSON.stringify({ state: music.playerState(), track: track(matches[0]) }); }
    if (a.action === 'play') music.play(); else if (a.action === 'pause') music.pause(); else if (a.action === 'next') music.nextTrack(); else if (a.action === 'previous') music.previousTrack(); else throw new Error('Unsupported control');
    return JSON.stringify({ state: music.playerState() });
  }
  throw new Error('Unknown static automation tool');
}
