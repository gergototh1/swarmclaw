// Eldobhato. Azt az egy kerdest donti el, hogy egy ad-hoc alairt buildbol
// megjelenik-e macOS rendszer-ertesites. Torolheto, amint a valasz megvan.
import { app, Notification } from 'electron'

app.whenReady().then(() => {
  console.log('[spike] Notification.isSupported() =', Notification.isSupported())
  if (!Notification.isSupported()) {
    console.log('[spike] NEM TAMOGATOTT — a 9-es task athuzasa kell')
    app.quit()
    return
  }
  const n = new Notification({ title: 'SwarmClaw', body: 'Ertesites-proba' })
  n.on('show', () => console.log('[spike] show esemeny megjott'))
  n.on('click', () => console.log('[spike] kattintas'))
  n.on('close', () => console.log('[spike] bezarva'))
  n.show()
  setTimeout(() => { console.log('[spike] vege'); app.quit() }, 20000)
})
