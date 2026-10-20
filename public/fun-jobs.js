(() => {
  'use strict';
  const launcher = document.querySelector('#fun-jobs-launcher');
  const panel = document.querySelector('#fun-jobs-panel');
  if (!launcher || !panel) return;

  const search = panel.querySelector('#fun-jobs-search');
  const list = panel.querySelector('#fun-jobs-list');
  const status = panel.querySelector('#fun-jobs-status');
  const empty = panel.querySelector('#fun-jobs-empty');
  const more = panel.querySelector('#fun-jobs-more');
  const count = panel.querySelector('#fun-jobs-count');
  const receipt = panel.querySelector('#fun-jobs-receipt');
  const since = panel.querySelector('#fun-jobs-since');
  const patterns = Object.freeze({
    repeat: 'Repeated', ascending: 'Ascending', descending: 'Descending',
    round: 'Milestone', palindrome: 'Palindrome', repeating: 'Repeating block'
  });
  const dateFormat = new Intl.DateTimeFormat('en-GB', {
    timeZone:'Asia/Seoul', year:'numeric', month:'short', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  });
  const pageSize = 20, refreshMs = 30000, freshnessMs = 180000;
  let opened = false, payload = null, savedArchive = null, savedReceivedAt = null;
  let shown = pageSize, errorMessage = '', failureCount = 0, nextRequestAt = 0;
  let activeRequest = null, refreshTimer = null;

  const stamp = value => dateFormat.format(typeof value === 'number' ? value : Date.parse(value)) + ' KST';
  const userLabel = value => typeof displayUserName === 'function' ? displayUserName(value) : value;
  const validDate = value => {
    if (typeof value !== 'string' || value.trim() !== value
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value)) return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && time >= 0 && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
  };
  const validHistory = record => {
    if (!Object.hasOwn(record, 'source') && !Object.hasOwn(record, 'submitted_at')) return true;
    return Object.hasOwn(record, 'source') && Object.hasOwn(record, 'submitted_at')
      && record.source === 'sacct' && validDate(record.submitted_at)
      && Date.parse(record.submitted_at) <= Date.parse(record.first_seen_at);
  };

  function validPayload(value) {
    if (!value || typeof value !== 'object' || !Number.isFinite(value.serverTime)
      || !(value.receivedAt === null || Number.isFinite(value.receivedAt)) || typeof value.stale !== 'boolean') return false;
    const archive = value.archive;
    if (archive === null) return true;
    return archive?.version === 1 && ['ok', 'unavailable', 'full'].includes(archive.status)
      && (archive.started_at === null || validDate(archive.started_at)) && Array.isArray(archive.records)
      && archive.records.length <= 1000 && new Set(archive.records.map(record => record?.job_id)).size === archive.records.length
      && archive.records.every(record => record && typeof record.job_id === 'string' && /^[1-9]\d{3,9}$/.test(record.job_id)
        && typeof record.name === 'string' && [...record.name].length <= 500 && typeof record.user === 'string' && [...record.user].length <= 80
        && Object.hasOwn(patterns, record.pattern) && validDate(record.first_seen_at)
        && validHistory(record) && archive.started_at !== null
        && Date.parse(record.first_seen_at) >= Date.parse(archive.started_at));
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function recordElement(record) {
    const item = element('li', 'fun-jobs-record');
    const top = element('div', 'fun-jobs-record-top');
    top.append(element('span', 'fun-jobs-id', record.job_id), element('span', 'fun-jobs-pattern', patterns[record.pattern]));
    item.append(top, element('p', 'fun-jobs-user', userLabel(record.user) || 'User unavailable'),
      element('p', 'fun-jobs-name', record.name || 'Job name unavailable'));
    const addTime = (label, date) => {
      const time = element('time', 'fun-jobs-time', `${label} ${stamp(date)}`);
      time.dateTime = date;
      item.append(time);
    };
    if (record.source === 'sacct') {
      item.append(element('p', 'fun-jobs-time fun-jobs-origin', 'Slurm history'));
      addTime('Submitted', record.submitted_at);
      addTime('Imported', record.first_seen_at);
    } else {
      addTime('First spotted', record.first_seen_at);
    }
    return item;
  }

  function render() {
    const archive = savedArchive;
    const query = search.value.trim().toLocaleLowerCase();
    const records = archive ? archive.records.filter(record =>
      [record.job_id, record.name, record.user, userLabel(record.user), patterns[record.pattern]]
        .some(value => value.toLocaleLowerCase().includes(query))) : [];
    const visible = records.slice(0, shown);
    list.replaceChildren(...visible.map(recordElement));
    more.hidden = visible.length >= records.length;
    more.textContent = `Load more (${records.length - visible.length} remaining)`;
    let message = '', warning = false;
    const unavailable = payload?.archive?.status === 'unavailable';
    const waiting = payload?.archive === null;
    const stale = payload?.stale || (Number.isFinite(savedReceivedAt) && Date.now() - savedReceivedAt >= freshnessMs);
    if (errorMessage) {
      message = errorMessage + (archive ? ' Showing the last received archive.' : ' Saved records cannot be checked right now.');
      warning = true;
    } else if (unavailable) {
      message = 'The collector could not update the archive. Previously saved IDs are shown when available.';
      warning = true;
    } else if (waiting) {
      message = archive ? 'Waiting for the collector to reconnect. Showing the last received archive.' : 'Waiting for the collector’s first archive report.';
    } else if (stale && payload) {
      message = 'Archive updates are delayed. Saved IDs remain visible; new discoveries may not have arrived yet.';
      warning = true;
    } else if (payload?.archive?.status === 'full') {
      message = 'The archive has reached its storage limit. Saved IDs remain available; new discoveries are paused.';
      warning = true;
    } else if (!payload) {
      message = 'Checking the shared archive…';
    }
    status.textContent = message;
    status.hidden = !message;
    status.dataset.kind = warning ? 'warning' : 'info';
    empty.hidden = visible.length > 0;
    empty.replaceChildren();
    if (!visible.length) {
      if (!archive) {
        empty.append(element('strong', '', unavailable || errorMessage ? 'Archive unavailable' : 'Your collection starts here'),
          document.createTextNode('Only IDs verified in Slurm reports or accounting history are saved. The examples above are not saved jobs.'));
      } else if (query) {
        empty.append(element('strong', '', 'No matching IDs'), document.createTextNode('Try a job ID, job name, or user.'));
      } else {
        empty.append(element('strong', '', 'No special IDs spotted yet'),
          document.createTextNode('New matches are saved automatically from Slurm reports. Imported matches from Slurm history also appear here.'));
      }
    }
    count.textContent = archive
      ? query ? `${records.length} matching · ${archive.records.length} saved` : `${archive.records.length} ${archive.records.length === 1 ? 'ID' : 'IDs'} saved · Shared with the lab`
      : 'Shared with the lab';
    receipt.textContent = Number.isFinite(savedReceivedAt) ? `Archive received ${stamp(savedReceivedAt)}` : '';
    receipt.hidden = !receipt.textContent;
    since.textContent = archive?.started_at ? `Automatic collection since ${stamp(archive.started_at)}` : '';
    since.hidden = !since.textContent;
  }

  function schedule() {
    clearTimeout(refreshTimer);
    if (!opened || document.hidden || activeRequest) return;
    refreshTimer = setTimeout(load, Math.max(0, nextRequestAt - Date.now()));
  }

  function pause() {
    clearTimeout(refreshTimer);
    if (activeRequest) {
      const request = activeRequest;
      activeRequest = null;
      clearTimeout(request.timeout);
      request.controller.abort();
    }
  }

  async function load() {
    if (!opened || document.hidden || activeRequest) return;
    if (Date.now() < nextRequestAt) return schedule();
    const request = {controller: new AbortController(), timeout: null};
    activeRequest = request;
    nextRequestAt = Date.now() + 5000;
    request.timeout = setTimeout(() => request.controller.abort(), 10000);
    panel.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/api/fun-jobs', {cache:'no-store', signal:request.controller.signal});
      if (!response.ok) throw new Error(`The archive could not be refreshed (${response.status}).`);
      const data = await response.json();
      if (!validPayload(data)) throw new Error('The archive returned an unexpected response.');
      if (activeRequest !== request) return;
      payload = data;
      if (data.archive && (data.archive.status !== 'unavailable' || (!savedArchive && data.archive.records.length))) {
        savedArchive = {...data.archive, records: [...data.archive.records].sort((a, b) =>
          Date.parse(b.first_seen_at) - Date.parse(a.first_seen_at) || b.job_id.localeCompare(a.job_id, 'en', {numeric:true}))};
        savedReceivedAt = data.receivedAt;
      }
      errorMessage = '';
      failureCount = 0;
      nextRequestAt = Date.now() + refreshMs;
      render();
    } catch (error) {
      if (activeRequest !== request) return;
      failureCount += 1;
      errorMessage = error?.name === 'AbortError' ? 'The archive request timed out.'
        : /^The archive /.test(error?.message || '') ? error.message : 'The archive could not be refreshed.';
      nextRequestAt = Date.now() + Math.min(300000, 60000 * 2 ** Math.min(failureCount - 1, 3));
      render();
    } finally {
      clearTimeout(request.timeout);
      if (activeRequest === request) {
        activeRequest = null;
        panel.removeAttribute('aria-busy');
        schedule();
      }
    }
  }

  function close() {
    if (!opened) return;
    opened = false;
    pause();
    panel.hidden = true;
    panel.removeAttribute('aria-busy');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus({preventScroll:true});
  }

  function open() {
    if (opened) return;
    opened = true;
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    render();
    search.focus({preventScroll:true});
    schedule();
  }

  launcher.addEventListener('click', () => opened ? close() : open());
  panel.querySelector('#fun-jobs-close').addEventListener('click', close);
  search.addEventListener('input', () => {shown = pageSize; render();});
  more.addEventListener('click', () => {
    const previous = shown;
    shown += pageSize;
    render();
    if (more.hidden && list.children[previous]) {
      list.children[previous].tabIndex = -1;
      list.children[previous].focus({preventScroll:true});
    }
  });
  document.addEventListener('keydown', event => {
    // Let an existing job-details modal own Escape when both windows are open.
    if (opened && event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      close();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pause();
      panel.removeAttribute('aria-busy');
    } else if (opened) {
      render();
      schedule();
    }
  });
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', () => {if (opened) schedule();});
})();
