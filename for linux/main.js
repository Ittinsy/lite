const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const fsp = fs.promises

app.commandLine.appendSwitch('no-sandbox')

const ROOT = app.isPackaged
  ? process.env.APPIMAGE ? path.dirname(process.env.APPIMAGE) : path.dirname(process.execPath)
  : path.join(__dirname, '..')
const DATA = path.join(ROOT, 'data')

const CONTAINERS = path.join(DATA, 'containers')
const dirOf = (id) => path.join(CONTAINERS, String(id))
const cfgOf = (id) => path.join(dirOf(id), 'config.json')
const profileOf = (id) => path.join(dirOf(id), 'profile')
app.setPath('userData', path.join(DATA, 'electron'))

const GPU_MODES = ['auto', 'off']
const CPU_OK = [2, 4, 6, 8, 10, 12, 14, 16]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findKernel() {
  const p = path.join(ROOT, 'kernel', 'chrome')
  return fs.existsSync(p) ? p : null
}

function normalize(e) {
  return {
    id: e.id,
    name: e.name || 'Browser',
    seed: e.seed,
    country: e.country || 'US',
    lang: e.lang || 'en-US',
    uiLang: e.uiLang === 'country' ? 'country' : 'en-US',
    timezone: e.timezone || 'America/New_York',
    cpu: CPU_OK.includes(+e.cpu) ? +e.cpu : 'auto',
    gpu: GPU_MODES.includes(e.gpu) ? e.gpu : 'auto',
    geo: e.geo === 'ask' ? 'ask' : 'deny',
    dnt: !!e.dnt,
    voicesOff: e.voicesOff !== false,
    webrtcProxy: e.webrtcProxy === true,
    proxy: String(e.proxy || '').trim(),
    homepage: String(e.homepage || '').trim(),
  }
}

const folderIds = () => {
  try { return fs.readdirSync(CONTAINERS).filter((n) => /^\d+$/.test(n)).map(Number) } catch { return [] }
}

function loadOne(id) {
  try { return normalize({ ...JSON.parse(fs.readFileSync(cfgOf(id), 'utf8')), id: Number(id) }) } catch { return null }
}

const loadAll = () => folderIds().map(loadOne).filter(Boolean).sort((a, b) => a.id - b.id)

function saveOne(e) {
  fs.mkdirSync(dirOf(e.id), { recursive: true })
  fs.writeFileSync(cfgOf(e.id), JSON.stringify(e, null, 2))
}

function setPrefs(e) {
  const dir = path.join(profileOf(e.id), 'Default')
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'Preferences')
  let j = {}
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
  j.profile = j.profile || {}
  j.profile.default_content_setting_values = j.profile.default_content_setting_values || {}
  j.profile.default_content_setting_values.geolocation = e.geo === 'ask' ? 3 : 2
  j.enable_do_not_track = !!e.dnt
  fs.writeFileSync(f, JSON.stringify(j))
}

function buildArgs(e) {
  const a = [
    `--user-data-dir=${profileOf(e.id)}`,
    `--fingerprint=${e.seed}`,
    '--fingerprint-brand=Chrome',
    `--lang=${e.uiLang === 'country' ? e.lang : 'en-US'}`,
    `--accept-lang=${e.lang},${e.lang.split('-')[0]}`,
    `--timezone=${e.timezone}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
  if (e.cpu !== 'auto') a.push(`--fingerprint-hardware-concurrency=${e.cpu}`)
  if (e.gpu === 'off') a.push('--disable-gpu-fingerprint')
  if (e.voicesOff) a.push('--disable-speech-api')
  if (e.webrtcProxy) a.push('--disable-non-proxied-udp')
  if (e.proxy) a.push(`--proxy-server=${e.proxy}`)
  if (e.homepage) a.push(e.homepage)
  return a
}

let win
const running = new Map()
const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload) }
const pushState = () => send('state', [...running.keys()])

async function killTree(id) {
  const p = running.get(id)
  if (!p) return
  const done = new Promise((r) => p.once('exit', r))
  try { process.kill(-p.pid, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} }
  await Promise.race([done, sleep(5000)])
  await sleep(500)
}

ipcMain.handle('list', () => ({ envs: loadAll(), running: [...running.keys()], kernel: !!findKernel() }))

ipcMain.handle('create', (_e, tpl, count) => {
  const ids = folderIds()
  const seeds = new Set(loadAll().map((x) => x.seed))
  let id = Math.max(0, ...ids)
  for (let i = 0; i < Math.min(Math.max(count, 1), 50); i++) {
    id++
    let seed
    do { seed = 1 + Math.floor(Math.random() * 2147483646) } while (seeds.has(seed))
    seeds.add(seed)
    fs.mkdirSync(profileOf(id), { recursive: true })
    saveOne(normalize({ ...tpl, id, seed, name: `${tpl.name || 'Browser'} ${id}` }))
  }
})

ipcMain.handle('update', (_e, env) => {
  const old = loadOne(env.id)
  if (old) saveOne(normalize({ ...old, ...env, id: old.id, seed: old.seed }))
})

ipcMain.handle('remove', async (_e, id) => {
  await killTree(id)
  try {
    await fsp.rm(dirOf(id), { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  } catch (err) {
    return { error: `Could not delete the folder (${err.code || err.message}). Close programs using it and retry, or delete it manually.` }
  }
  return {}
})

ipcMain.handle('launch', (_e, id) => {
  const env = loadOne(id)
  const kernel = findKernel()
  if (!kernel) return { error: 'Kernel not found: kernel/chrome is missing.' }
  if (!env) return { error: 'Container not found.' }
  if (running.has(id)) return {}
  try {
    fs.mkdirSync(profileOf(id), { recursive: true })
    setPrefs(env)
  } catch (err) {
    return { error: 'Failed to write container settings: ' + err.message }
  }

  const p = spawn(kernel, buildArgs(env), { stdio: 'ignore', detached: true })
  const finish = () => {
    if (running.get(id) === p) running.delete(id)
    pushState()
  }
  p.on('exit', finish)
  p.on('error', (err) => { finish(); send('notice', 'Could not start the browser: ' + err.message) })
  running.set(id, p)
  pushState()
  return {}
})

ipcMain.handle('stop', (_e, id) => killTree(id))

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1200, height: 780, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile(path.join(__dirname, 'index.html'))
})
app.on('window-all-closed', () => app.quit())
