'use strict';
// Local mock of the three hosts: upload-server endpoint (hands out dead node first), upload endpoint (multipart),
// file info / encodings with scripted progress. NO real network, NO real keys.
const http = require('http');
const net = require('net');

function startMock(opts = {}) {
  const state = { serverCalls: 0, uploads: [], infoCalls: 0, encCalls: 0, deadNodes: opts.deadNodes ?? 1, stallFirst: opts.stallFirst || 0, receivedHashes: [] };
  const KEY = 'TESTKEY_abcdef123456';
  let port;
  // a "dead" node: a port that accepts nothing (closed)
  const closedPort = 1; // connection refused on localhost
  // a black hole node: accepts TCP and never answers (to test connect-ish stall)
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/api/upload/server') {
      state.serverCalls += 1;
      if (url.searchParams.get('key') !== KEY) return send(200, { status: 403, msg: 'Wrong Auth' });
      let node;
      if (state.serverCalls <= state.deadNodes) node = `http://127.0.0.1:${closedPort}/upload/01`;
      else if (state.serverCalls <= state.deadNodes + state.stallFirst) node = `http://127.0.0.1:${port}/stall/01`;
      else node = `http://127.0.0.1:${port}/upload/01`;
      return send(200, { status: 200, result: node });
    }
    if (url.pathname.startsWith('/upload/') || url.pathname.startsWith('/stall/')) {
      const stall = url.pathname.startsWith('/stall/');
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (!stall) { chunks.push(c); }
        else { req.pause(); } // read one chunk then stop reading: client stalls on backpressure
      });
      if (stall) return;
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('latin1');
        const hasKey = text.includes(KEY);
        const m = /filename="([^"]*)"/.exec(text);
        let fileSha = null;
        try {
          const b = /^--(\S+)\r\n/.exec(text)[1];
          const start = buf.indexOf(Buffer.from('\r\n\r\n', 'latin1'), buf.indexOf(Buffer.from('name="file"'))) + 4;
          const end = buf.lastIndexOf(Buffer.from(`\r\n--${b}--`, 'latin1'));
          fileSha = require('crypto').createHash('sha256').update(buf.subarray(start, end)).digest('hex');
        } catch {}
        state.uploads.push({ fileSha, fields: [...text.matchAll(/name="([^"]+)"/g)].map((x) => x[1]), size, hasKey, query: url.search, filename: m && m[1], contentLength: req.headers['content-length'] });
        const delay = opts.responseDelay || 0;
        setTimeout(() => {
          if (opts.host === 'doodstream') return send(200, { status: 200, result: [{ filecode: 'dood123', canplay: 0 }] });
          if (opts.host === 'voe') return send(200, { success: true, message: 'ok', file: { id: 1, file_code: 'voe123', file_title: 'x', encoding_necessary: true } });
          send(200, { msg: 'OK', status: 200, files: [{ filecode: 'earn123', filename: 'x.mp4', status: 'OK' }] });
        }, delay);
      });
      return;
    }
    if (url.pathname === '/api/encodings/list') {
      state.voeEncCalls = (state.voeEncCalls || 0) + 1;
      if (!opts.voeMode) return send(404, { status: 404 });
      const mode = opts.voeMode;
      const n = state.voeEncCalls;
      const other = { file_code: 'someoneelse', status: 'ENCODING', percent: 5, quality: 480 };
      let data = [other];
      if (mode === 'encode') { if (n === 1) data.push({ file_code: 'voe123', status: 'ENCODING', percent: 10, quality: 1080 }, { file_code: 'voe123', status: 'ENCODING', percent: 30, quality: 720 }); else if (n === 2) data.push({ file_code: 'voe123', status: 'ENCODING', percent: 60, quality: 1080 }, { file_code: 'voe123', status: 'ENCODING', percent: 80, quality: 720 }); }
      if (mode === 'error') data.push({ file_code: 'voe123', status: 'ERROR', percent: 12, quality: 1080, error: 'Unsupported codec' });
      if (mode === 'nolist') return send(200, { message: 'weird' });
      return send(200, { data });
    }
    if (url.pathname === '/api/file/info') {
      if (opts.host === 'voe' || opts.voeMode) { if (opts.voeMode === 'notfound') return send(200, { status: 200, result: [{ status: 404, fileCode: url.searchParams.get('file_code') }] }); if (opts.voeMode) return send(200, { status: 200, result: [{ status: 200, fileCode: url.searchParams.get('file_code'), name: 'x' }] }); }
      state.infoCalls += 1;
      const canplay = state.infoCalls > (opts.canplayAfter ?? 3) ? 1 : 0;
      return send(200, { status: 200, result: [opts.voeNoFlag ? { file_code: 'voe123', status: 200 } : { file_code: url.searchParams.get('file_code'), canplay, status: canplay ? 'Ready' : 'Encoding' }] });
    }
    if (url.pathname === '/api/file/encodings') {
      state.encCalls += 1;
      const p = Math.min(100, state.encCalls * 30);
      return send(200, { status: 200, result: [{ progress: p, status: 'ENCODING', quality: 'h' }, { progress: Math.max(0, p - 20), status: 'PENDING', quality: 'l' }] });
    }
    send(404, { status: 404 });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    port = server.address().port;
    resolve({ port, state, KEY, base: `http://127.0.0.1:${port}`, close: () => { sockets.forEach((s) => s.destroy()); return new Promise((r) => server.close(r)); } });
  }));
}
module.exports = { startMock };
