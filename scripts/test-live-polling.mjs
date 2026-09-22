import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await Promise.all(['app.js', 'gpu-jobs.js', 'live.js'].map(name =>
  readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')));
const flush = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};

// Run the actual browser scripts against a small DOM and controllable browser
// clock. No network, wall-clock sleep, or external browser dependency is needed.
function browser({hidden = false, holdRequest = false} = {}) {
  let now = Date.parse('2026-09-22T10:00:00Z'), timerId = 0;
  const timers = new Map(), elements = new Map(), listeners = new Map(), requests = [], responses = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', textContent: '', disabled: false, addEventListener() {}, showModal() {},
      classList: {toggle() {}}, setAttribute() {}
    });
    return elements.get(selector);
  };
  class BrowserDate extends Date {static now() {return now;}}
  const snapshot = () => ({
    nodes: [{receivedAt: now, data: {server_name: 'devbox', gpus: [
      {id: 0, gpu_utilization: 40, vram_total_mb: 1024, vram_total_used_mb: 256,
        processes: [{pid: 1, slurm_job_id: '1', username: 'lab-user'}]}
    ]}}],
    slurm: {receivedAt: now, data: {sinfo: [{name: 'devbox', state: 'MIXED'}],
      squeue: [{job_id: '1', name: 'Training', user: 'lab-user', job_state: 'RUNNING'}]}}
  });
  const document = {
    hidden, querySelector: element, querySelectorAll: () => [],
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    }
  };
  const context = vm.createContext({
    structuredClone, Date: BrowserDate, Intl, AbortController, document,
    window: {addEventListener() {}},
    setTimeout(callback, delay) {timers.set(++timerId, {at: now + delay, callback}); return timerId;},
    clearTimeout(id) {timers.delete(id);},
    fetch: async (url, options) => {
      const request = {at: now, signal: options.signal};
      requests.push(request);
      if (holdRequest) {
        holdRequest = false;
        return await new Promise((resolve, reject) => {
          request.resolve = resolve;
          options.signal.addEventListener('abort', () => reject(Object.assign(new Error(), {name: 'AbortError'})));
        });
      }
      const response = responses.length ? responses.shift() : {status: 200, body: snapshot()};
      if (response.networkError) throw new TypeError('Network unavailable');
      return {ok: response.status >= 200 && response.status < 300, status: response.status,
        json: async () => {if (response.invalidJSON) throw new SyntaxError('Malformed JSON'); return response.body;}};
    }
  });
  for (const script of source) vm.runInContext(script, context);
  return {
    requests, responses, element, snapshot, timers,
    state: () => vm.runInContext('({...liveState})', context),
    evaluate: code => vm.runInContext(code, context),
    async visibility(value) {
      document.hidden = value;
      for (const listener of listeners.get('visibilitychange') || []) listener();
      await flush();
    },
    async advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at; timers.delete(id); timer.callback(); await flush();
      }
      now = end; await flush();
    }
  };
}

// A background-loaded page performs no request and runs no polling timers.
const hidden = browser({hidden: true});
await flush();
assert.equal(hidden.requests.length, 0);
assert.equal(hidden.timers.size, 0);
await hidden.advance(600000);
assert.equal(hidden.requests.length, 0);
await hidden.visibility(false);
assert.equal(hidden.requests.length, 1);
assert.equal(hidden.state().error, null);

// Visible pages use the 30-second cadence. Hidden pages cancel both network and
// cooldown timers, and a healthy return refreshes without waiting for that cadence.
const healthy = browser();
await flush();
assert.equal(healthy.requests.length, 1);
assert.match(healthy.element('.sample-note').innerHTML, /Auto-refresh every 30 seconds/);
assert.equal(healthy.element('#retry-live').textContent, 'Refresh in 5s');
assert.equal(healthy.element('#retry-live').disabled, true);
await healthy.advance(4000);
assert.equal(healthy.element('#retry-live').textContent, 'Refresh in 1s');
await healthy.element('#retry-live').onclick();
assert.equal(healthy.requests.length, 1);
await healthy.advance(1000);
assert.equal(healthy.element('#retry-live').textContent, 'Refresh now ↗');
assert.equal(healthy.element('#retry-live').disabled, false);
await healthy.advance(24999);
assert.equal(healthy.requests.length, 1);
await healthy.advance(1);
assert.equal(healthy.requests.length, 2);
await healthy.visibility(true);
assert.equal(healthy.timers.size, 0);
await healthy.advance(60000);
assert.equal(healthy.requests.length, 2);
await healthy.visibility(false);
assert.equal(healthy.requests.length, 3);
await healthy.visibility(true);
await healthy.advance(1000);
await healthy.visibility(false);
assert.equal(healthy.requests.length, 3);
await healthy.advance(3999);
assert.equal(healthy.requests.length, 3);
await healthy.advance(1);
assert.equal(healthy.requests.length, 4);

// Manual refresh bypasses normal polling, but even repeated programmatic clicks
// cannot issue requests less than 5 seconds apart.
await healthy.element('#retry-live').onclick();
assert.equal(healthy.requests.length, 4);
await healthy.advance(5000);
await healthy.element('#retry-live').onclick(); await flush();
assert.equal(healthy.requests.length, 5);
assert.equal(healthy.requests.at(-1).at - healthy.requests.at(-2).at, 5000);

// Hiding during an in-flight read aborts it without converting a deliberate
// pause into a network error or retry penalty. Returning resumes safely.
const inFlight = browser({holdRequest: true});
await flush();
assert.equal(inFlight.state().loading, true);
await inFlight.visibility(true);
assert.equal(inFlight.requests[0].signal.aborted, true);
assert.equal(inFlight.state().loading, false);
assert.equal(inFlight.state().error, null);
assert.equal(inFlight.state().failureCount, 0);
assert.equal(inFlight.timers.size, 0);
await inFlight.advance(5000);
await inFlight.visibility(false);
assert.equal(inFlight.requests.length, 2);
assert.equal(inFlight.state().snapshot.nodes.length, 1);

// A tab can become visible before the aborted fetch has settled. Its completion
// must still resume exactly once instead of losing the visibility event.
const rapidReturn = browser({holdRequest: true});
await flush(); await rapidReturn.advance(5000);
await Promise.all([rapidReturn.visibility(true), rapidReturn.visibility(false)]);
await flush();
assert.equal(rapidReturn.requests.length, 2);
assert.equal(rapidReturn.state().error, null);
assert.equal(rapidReturn.state().loading, false);

// Quota and request backoff survive visibility changes; explicit manual refresh
// can recover immediately once its 5-second cooldown has elapsed.
const failures = browser();
await flush(); await failures.advance(5000);
failures.responses.push({status: 503, body: {error: 'storage_quota_exceeded', retry_at: Date.parse('2026-09-23T00:00:00Z')}});
await failures.element('#retry-live').onclick(); await flush();
assert.equal(failures.state().errorKind, 'quota');
assert.match(failures.state().error, /09:00:00 KST/);
assert.equal(failures.evaluate('nodes[0].stale'), true);
assert.equal(failures.evaluate('nodes[0].gpus[0].util'), null);
assert.equal(failures.state().snapshot.nodes.length, 1);
assert.equal(failures.state().nextAttemptAt - failures.requests.at(-1).at, 300000);
await failures.visibility(true); await failures.advance(60000); await failures.visibility(false);
assert.equal(failures.requests.length, 2);
await failures.element('#retry-live').onclick(); await flush();
assert.equal(failures.requests.length, 3);
assert.equal(failures.state().error, null);
assert.equal(failures.state().failureCount, 0);
assert.equal(failures.evaluate('nodes[0].stale'), false);
for (const [expectedDelay, response] of [
  [120000, {status: 503, body: {error: 'storage_unavailable'}}],
  [240000, {status: 200, invalidJSON: true}],
  [300000, {networkError: true}]
]) {
  await failures.advance(5000); failures.responses.push(response);
  await failures.element('#retry-live').onclick(); await flush();
  assert.equal(failures.state().nextAttemptAt - failures.requests.at(-1).at, expectedDelay);
  assert.equal(failures.state().snapshot.nodes.length, 1);
}

// The 3-minute boundary and help text agree, including reports that age while
// hidden. No extra network reads are needed just to evaluate freshness.
failures.evaluate('liveState.error=null;');
assert.equal(failures.evaluate('fresh(Date.now()-179000)'), true);
assert.equal(failures.evaluate('fresh(Date.now()-180000)'), false);
failures.evaluate('showDataInfo();');
assert.match(failures.element('#dialog-content').innerHTML, /every 30 seconds/);
assert.match(failures.element('#dialog-content').innerHTML, /older than 3 minutes/);
assert.match(failures.element('#dialog-content').innerHTML, /at least 5 seconds/);

console.log('PASS: hidden startup/pause, abort and visibility resume, 30-second cadence, 5-second manual cooldown, quota/error backoff and recovery, retained stale data, and 3-minute freshness.');
