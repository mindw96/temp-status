(() => {
  'use strict';
  const launcher = document.querySelector('#sbatch-rankings-launcher');
  const panel = document.querySelector('#sbatch-rankings-panel');
  if (!launcher || !panel) return;

  const tabs = [...panel.querySelectorAll('[role="tab"]')];
  const results = panel.querySelector('#sbatch-rankings-results');
  const list = panel.querySelector('#sbatch-rankings-list');
  const status = panel.querySelector('#sbatch-rankings-status');
  const summary = panel.querySelector('#sbatch-rankings-summary');
  const empty = panel.querySelector('#sbatch-rankings-empty');
  const updated = panel.querySelector('#sbatch-rankings-updated');
  const coverage = panel.querySelector('#sbatch-rankings-coverage');
  const periods = ['today', 'week', 'month', 'all'];
  const refreshMs = 30000, freshnessMs = 180000;
  const numberFormat = new Intl.NumberFormat('ko-KR');
  const dateFormat = new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit'});
  const timeFormat = new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'});
  let opened = false, selected = 'today', payload = null, savedRankings = null;
  let errorMessage = '', failureCount = 0, nextRequestAt = 0, clockOffset = 0;
  let activeRequest = null, refreshTimer = null;

  const userLabel = value => typeof displayUserName === 'function' ? displayUserName(value) : value;
  const validDate = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value)) return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && time >= 0 && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
  };
  const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;

  function validPeriod(period) {
    return period && (period.start === null || validDate(period.start))
      && nonnegativeInteger(period.total) && nonnegativeInteger(period.users)
      && period.users <= period.total && Array.isArray(period.top) && period.top.length <= 5
      && period.top.length <= period.users
      && new Set(period.top.map(row => row?.user)).size === period.top.length
      && period.top.every(row => row && typeof row.user === 'string' && row.user.length > 0 && [...row.user].length <= 80
        && Number.isSafeInteger(row.count) && row.count > 0 && row.count <= period.total);
  }

  function validPayload(value) {
    if (!value || typeof value !== 'object' || !Number.isFinite(value.serverTime)
      || !(value.receivedAt === null || Number.isFinite(value.receivedAt)) || typeof value.stale !== 'boolean') return false;
    const rankings = value.rankings;
    if (rankings === null) return true;
    return rankings?.version === 1 && ['ok', 'unavailable'].includes(rankings.status)
      && rankings.timezone === 'Asia/Seoul'
      && (rankings.collected_at === null || validDate(rankings.collected_at))
      && (rankings.history_start === null || validDate(rankings.history_start))
      && periods.every(key => validPeriod(rankings.periods?.[key]))
      && (rankings.status !== 'ok' || (rankings.collected_at !== null
        && periods.slice(0, 3).every(key => rankings.periods[key].start !== null)));
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function recordElement(record, index) {
    const item = element('li', 'sbatch-rankings-record');
    const count = element('span', 'sbatch-rankings-count', numberFormat.format(record.count));
    count.append(element('small', '', '회'));
    item.append(element('span', 'sbatch-rankings-position', String(index + 1)),
      element('span', 'sbatch-rankings-user', userLabel(record.user)), count);
    return item;
  }

  function render() {
    const rankings = savedRankings;
    const period = rankings?.periods[selected];
    const records = period ? [...period.top].sort((a, b) => b.count - a.count || a.user.localeCompare(b.user, 'en')) : [];
    list.replaceChildren(...records.map(recordElement));
    const unavailable = payload?.rankings?.status === 'unavailable';
    const waiting = payload?.rankings === null;
    const stale = payload?.stale || (rankings?.collected_at && Date.now() + clockOffset - Date.parse(rankings.collected_at) >= freshnessMs);
    let message = '', warning = false;
    if (errorMessage) {
      message = errorMessage + (rankings ? ' 마지막으로 확인한 집계를 표시합니다.' : ' 아직 제출 횟수를 확인할 수 없습니다.');
      warning = true;
    } else if (unavailable) {
      message = 'Slurm 제출 기록을 집계하지 못했습니다.' + (rankings ? ' 마지막으로 확인한 집계를 표시합니다.' : '');
      warning = true;
    } else if (waiting) {
      message = rankings ? '수집기 연결을 기다리고 있습니다. 마지막 집계를 표시합니다.' : '수집기의 첫 집계를 기다리고 있습니다.';
    } else if (stale) {
      message = '집계가 지연되고 있습니다. 아래 갱신 시각의 횟수를 표시합니다.';
      warning = true;
    } else if (!payload) {
      message = 'Slurm 제출 기록을 확인하고 있습니다…';
    }
    status.textContent = message;
    status.hidden = !message;
    status.dataset.kind = warning ? 'warning' : 'info';
    summary.textContent = period ? `총 ${numberFormat.format(period.total)}회 · ${numberFormat.format(period.users)}명`
      + (selected !== 'all' && period.start ? ` · ${dateFormat.format(new Date(period.start))}부터` : '') : '';
    summary.hidden = !period;
    empty.hidden = records.length > 0;
    empty.replaceChildren();
    if (!records.length) {
      if (!rankings) {
        empty.append(element('strong', '', unavailable || errorMessage ? '집계 정보를 확인할 수 없습니다' : '랭킹을 준비하고 있습니다'),
          document.createTextNode('확인된 sbatch 제출 횟수가 여기에 표시됩니다.'));
      } else {
        empty.append(element('strong', '', '이 기간에는 제출 기록이 없습니다'),
          document.createTextNode('새로운 sbatch 제출이 확인되면 자동으로 갱신됩니다.'));
      }
    }
    updated.textContent = rankings?.collected_at ? `${timeFormat.format(new Date(rankings.collected_at))} KST 갱신` : '집계 대기 중';
    coverage.textContent = rankings?.history_start
      ? `Slurm 보관 기록: ${dateFormat.format(new Date(rankings.history_start))}부터`
      : 'Slurm에 남아 있는 제출 기록 기준';
  }

  function selectPeriod(key, focus = false) {
    if (!periods.includes(key)) return;
    selected = key;
    for (const tab of tabs) {
      const active = tab.dataset.period === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus({preventScroll:true});
    }
    results.setAttribute('aria-labelledby', `sbatch-rankings-tab-${selected}`);
    render();
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
    const request = {controller:new AbortController(), timeout:null};
    activeRequest = request;
    nextRequestAt = Date.now() + 5000;
    request.timeout = setTimeout(() => request.controller.abort(), 10000);
    panel.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/api/sbatch-rankings', {cache:'no-store', signal:request.controller.signal});
      if (!response.ok) throw new Error('랭킹을 새로 불러오지 못했습니다.');
      const data = await response.json();
      if (!validPayload(data)) throw new Error('랭킹 응답 형식을 확인할 수 없습니다.');
      if (activeRequest !== request) return;
      payload = data;
      clockOffset = data.serverTime - Date.now();
      if (data.rankings?.collected_at) {
        const incomingTime = Date.parse(data.rankings.collected_at);
        const savedTime = savedRankings ? Date.parse(savedRankings.collected_at) : null;
        // A failed collection can still carry a newer valid server-side cache.
        if (!savedRankings || incomingTime > savedTime
          || (incomingTime === savedTime && data.rankings.status === 'ok')) savedRankings = data.rankings;
      }
      errorMessage = '';
      failureCount = 0;
      nextRequestAt = Date.now() + refreshMs;
      render();
    } catch (error) {
      if (activeRequest !== request) return;
      failureCount += 1;
      errorMessage = error?.name === 'AbortError' ? '랭킹 요청 시간이 초과되었습니다.'
        : /^랭킹 /.test(error?.message || '') || /^랭킹을 /.test(error?.message || '') ? error.message : '랭킹을 새로 불러오지 못했습니다.';
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
    tabs.find(tab => tab.dataset.period === selected).focus({preventScroll:true});
    schedule();
  }

  launcher.addEventListener('click', () => opened ? close() : open());
  panel.querySelector('#sbatch-rankings-close').addEventListener('click', close);
  for (const tab of tabs) {
    tab.addEventListener('click', () => selectPeriod(tab.dataset.period));
    tab.addEventListener('keydown', event => {
      const current = periods.indexOf(tab.dataset.period);
      let next;
      if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (current + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectPeriod(periods[next], true);
    });
  }
  document.addEventListener('keydown', event => {
    // The job-details modal owns Escape while it is open.
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
