const { app, BrowserWindow } = require('electron')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const P = 'persist:torra-deepseek-web'
  const win = new BrowserWindow({
    show: false,
    webPreferences: { partition: P, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  await win.webContents.loadURL('https://chat.deepseek.com/sign_in').catch(() => {})
  await new Promise((r) => setTimeout(r, 5000))
  const r = await win.webContents.executeJavaScript(`(() => {
    const c = (s) => { try { return document.querySelectorAll(s).length } catch { return -1 } };
    const btns = [...document.querySelectorAll('button')].map(b => (b.textContent||'').trim()).filter(Boolean).slice(0, 12);
    return {
      url: location.href,
      formActionLogin: c('form[action*="login"]'),
      nameCaptcha: c('[name="captcha"]'),
      iframeRecaptcha: c('iframe[src*="recaptcha"]'),
      allForms: c('form'),
      allInputs: c('input'),
      inputMeta: [...document.querySelectorAll('input')].slice(0,8).map(i => i.type + '|' + (i.name||'') + '|' + (i.placeholder||'').slice(0,20)),
      buttonTexts: btns,
      hasPasswordInput: c('input[type="password"]'),
      bodyLen: (document.body?.innerText||'').length,
    };
  })()`, true)
  console.log(JSON.stringify(r, null, 2))
  app.exit(0)
})
